import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { initialState, tick, validateConfig, discover } from "./lib/local-release-poller.mjs";
import { mcpSession, saveJson, readAuthorization } from "./lib/local-release-io.mjs";
const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40),
  merge = "d".repeat(40);
const config = () =>
  validateConfig({
    upstream: "example/upstream",
    fork: "example/fork",
    projectId: "project",
    baseBranch: "main",
    upstreamBranch: "main",
    endpoint: "http://127.0.0.1:3773/mcp",
    authorizationFile: "auth",
    stateFile: "state",
    accepted: { tag: "v1.0.0", sha: a },
    intervalSeconds: 300,
    workerBudgetMinutes: 90,
  });
function fixture() {
  const cfg = config();
  const data = {
    latest: "v1.1.0",
    tags: { "v1.0.0": a, "v1.1.0": b, "v1.2.0": c, "v2.0.0-voice.1": merge },
    prs: [],
    releases: [],
    status: "running",
    thread: "worker",
    activeRunId: "run",
    calls: [],
    saves: [],
    now: 1_000,
    comparison: "ahead",
    failAfterAccept: false,
  };
  const state = initialState(cfg, "auth-hash");
  const io = {
    authHash: "auth-hash",
    now: () => data.now,
    save: async (s) => {
      data.saves.push(structuredClone(s));
    },
    api: async (path) => {
      if (path.endsWith("/releases/latest"))
        return { tag_name: data.latest, target_commitish: "main", draft: false, prerelease: false };
      if (path.includes("/git/ref/tags/")) {
        const tag = decodeURIComponent(path.split("/tags/")[1]);
        return { ref: `refs/tags/${tag}`, object: { type: "commit", sha: data.tags[tag] } };
      }
      if (path.includes("/commits/")) return { sha: c };
      if (path.includes("/compare/")) return { status: data.comparison };
      if (path.includes("/pulls?")) return data.prs;
      if (path.includes("/releases?")) return data.releases;
      throw new Error(`Unexpected ${path}`);
    },
    call: async (tool, args) => {
      data.calls.push({ tool, args: structuredClone(args) });
      if (tool === "t3_thread_read")
        return {
          thread: {
            projectId: "project",
            archived: false,
            status: data.status,
            latestRunId: "run",
            activeRunId: data.activeRunId,
            pendingRequestCount: 0,
            ...data.threadOverrides,
          },
        };
      if (data.failAfterAccept) throw new Error("lost response");
      return { threadId: data.thread };
    },
  };
  return { cfg, state, io, data, run: (options) => tick(cfg, state, io, options) };
}
function merged(f) {
  f.data.status = "completed";
  f.data.activeRunId = null;
  f.data.prs = [
    {
      number: 1,
      state: "closed",
      merged_at: "2026-01-01",
      merge_commit_sha: merge,
      head: { ref: f.state.active.branch, repo: { full_name: "example/fork" } },
      base: { ref: "main" },
    },
  ];
  f.data.releases = [
    {
      prerelease: true,
      draft: false,
      assets: [{}],
      tag_name: "v2.0.0-voice.1",
      body: `Upstream-Commit: ${b}`,
      html_url: "https://github.com/example/fork/releases/tag/v2.0.0-voice.1",
    },
  ];
}
NodeTest.test("unchanged release is a no-op and dry-run has no writes or dispatch", async () => {
  const f = fixture();
  NodeAssert.match(await f.run({ dryRun: true }), /Would start/);
  NodeAssert.equal(f.data.saves.length, 0);
  NodeAssert.equal(f.data.calls.length, 0);
  f.data.latest = "v1.0.0";
  NodeAssert.match(await f.run(), /No new/);
  NodeAssert.equal(f.state.active, null);
});
NodeTest.test(
  "launch persists exact request before dispatch, and survives lost reply/restart",
  async () => {
    const f = fixture();
    f.data.failAfterAccept = true;
    await NodeAssert.rejects(f.run(), /lost response/);
    const pending = structuredClone(f.state.pending);
    NodeAssert.equal(
      f.data.saves.at(-1).pending.args.clientRequestId,
      pending.args.clientRequestId,
    );
    f.data.failAfterAccept = false;
    const restarted = structuredClone(f.data.saves.at(-1));
    await tick(f.cfg, restarted, f.io);
    NodeAssert.deepEqual(
      f.data.calls.filter((x) => x.tool === "t3_thread_launch").map((x) => x.args),
      [pending.args, pending.args],
    );
    NodeAssert.equal(restarted.active.threadId, "worker");
    NodeAssert.equal(restarted.pending, null);
    NodeAssert.deepEqual(pending.args.workspaceStrategy, {
      type: "worktree",
      baseRef: "origin/main",
      branch: pending.args.workspaceStrategy.branch,
      startFromOrigin: true,
    });
  },
);
NodeTest.test("new releases immediately steer the busy thread and reuse its branch", async () => {
  const f = fixture();
  await f.run();
  const branch = f.state.active.branch;
  f.data.latest = "v1.2.0";
  await f.run();
  NodeAssert.equal(f.state.desired.sha, c);
  NodeAssert.equal(f.data.calls.filter((x) => x.tool === "t3_thread_send").length, 1);
  const sends = f.data.calls.filter((x) => x.tool === "t3_thread_send");
  NodeAssert.equal(sends.length, 1);
  NodeAssert.equal(sends[0].args.threadId, "worker");
  NodeAssert.equal(sends[0].args.mode, "auto");
  NodeAssert.equal(f.state.active.branch, branch);
  NodeAssert.equal(f.state.active.target.sha, c);
  await f.run();
  NodeAssert.equal(f.data.calls.filter((x) => x.tool === "t3_thread_send").length, 1);
});
NodeTest.test("pending send replay stays byte-identical even when upstream changes", async () => {
  const f = fixture();
  await f.run();
  f.data.latest = "v1.2.0";
  f.data.activeRunId = null;
  f.data.status = "completed";
  f.data.failAfterAccept = true;
  await NodeAssert.rejects(f.run(), /lost response/);
  const pending = structuredClone(f.state.pending);
  f.data.failAfterAccept = false;
  await f.run();
  NodeAssert.deepEqual(
    f.data.calls.filter((x) => x.tool === "t3_thread_send").map((x) => x.args),
    [pending.args, pending.args],
  );
});
NodeTest.test(
  "credential rotation cannot replay uncertain work; acknowledged work can reconnect",
  async () => {
    const f = fixture();
    f.data.failAfterAccept = true;
    await NodeAssert.rejects(f.run());
    f.io.authHash = "new";
    await NodeAssert.rejects(f.run(), /Credential changed/);
    f.io.authHash = "auth-hash";
    f.data.failAfterAccept = false;
    await f.run();
    f.io.authHash = "new";
    await f.run();
    NodeAssert.equal(f.state.authHash, "new");
  },
);
NodeTest.test(
  "completion needs merge, matching publication, and a second quiet observation",
  async () => {
    const f = fixture();
    await f.run();
    merged(f);
    await f.run();
    NodeAssert.ok(f.state.active);
    NodeAssert.equal(f.state.accepted.sha, a);
    f.data.now += 11_000;
    await f.run();
    NodeAssert.equal(f.state.active, null);
    NodeAssert.equal(f.state.accepted.sha, b);
    NodeAssert.equal(f.data.calls.filter((x) => x.tool === "t3_thread_launch").length, 1);
  },
);
NodeTest.test("background tasks and wake runs prevent premature completion", async () => {
  const f = fixture();
  await f.run();
  merged(f);
  await f.run();
  f.data.now += 11_000;
  f.data.threadOverrides = { pendingBackgroundTasks: [{ taskId: "task" }] };
  await f.run();
  NodeAssert.ok(f.state.active);
  NodeAssert.equal(f.state.active.quiet, undefined);
  f.data.threadOverrides = { latestRunId: "wake-run" };
  await f.run();
  NodeAssert.ok(f.state.active);
});
NodeTest.test(
  "published old target completes before a newer target gets its own thread",
  async () => {
    const f = fixture();
    await f.run();
    merged(f);
    await f.run();
    f.data.now += 11_000;
    f.data.latest = "v1.2.0";
    await f.run();
    NodeAssert.equal(f.state.accepted.sha, b);
    NodeAssert.equal(f.state.active.target.sha, c);
    NodeAssert.equal(f.data.calls.filter((x) => x.tool === "t3_thread_launch").length, 2);
  },
);
for (const change of ["draft", "no-assets", "wrong-marker", "not-prerelease", "not-descendant"])
  NodeTest.test(`rejects incomplete release proof: ${change}`, async () => {
    const f = fixture();
    await f.run();
    merged(f);
    await f.run();
    f.data.now += 11_000;
    if (change === "draft") f.data.releases[0].draft = true;
    if (change === "no-assets") f.data.releases[0].assets = [];
    if (change === "wrong-marker") f.data.releases[0].body = `Upstream-Commit: ${a}`;
    if (change === "not-prerelease") f.data.releases[0].prerelease = false;
    if (change === "not-descendant") f.data.comparison = "diverged";
    await f.run();
    NodeAssert.ok(f.state.active);
    NodeAssert.equal(f.state.accepted.sha, a);
  });
NodeTest.test("closed unmerged PR and failed thread never count as delivered", async () => {
  const f = fixture();
  await f.run();
  merged(f);
  f.data.prs[0].merged_at = null;
  await NodeAssert.rejects(f.run(), /closed without merge/);
  NodeAssert.ok(f.state.active);
  f.data.prs = [];
  f.data.status = "failed";
  f.data.latest = "v1.2.0";
  await f.run();
  NodeAssert.equal(f.state.accepted.sha, a);
  NodeAssert.equal(f.data.calls.filter((x) => x.tool === "t3_thread_launch").length, 1);
});
NodeTest.test("rejects moved tags, regressions and non-main ancestry", async () => {
  const f = fixture();
  f.data.tags["v1.0.0"] = c;
  await NodeAssert.rejects(f.run(), /tag moved/);
  f.data.tags["v1.0.0"] = a;
  f.data.latest = "v0.9.0";
  f.data.tags["v0.9.0"] = b;
  await NodeAssert.rejects(f.run(), /regressed/);
  f.data.latest = "v1.1.0";
  f.data.comparison = "diverged";
  await NodeAssert.rejects(f.run(), /outside upstream/);
});
NodeTest.test("annotated tags peel to immutable commits and reject excessive nesting", async () => {
  const f = fixture();
  const api = async (path) =>
    path.endsWith("/tags/v1.1.0")
      ? { ref: "refs/tags/v1.1.0", object: { type: "tag", sha: merge } }
      : path.endsWith(`/git/tags/${merge}`)
        ? { sha: merge, tag: "v1.1.0", object: { type: "commit", sha: b } }
        : f.io.api(path);
  NodeAssert.equal((await discover(f.cfg, api, f.state.accepted)).sha, b);
});
NodeTest.test("config rejects insecure remote endpoints and unsafe branches", () => {
  NodeAssert.throws(
    () => validateConfig({ ...config(), endpoint: "http://example.com/mcp" }),
    /HTTPS/,
  );
  NodeAssert.throws(() => validateConfig({ ...config(), baseBranch: "--evil" }), /Invalid/);
});
NodeTest.test("atomic state and private authorization", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "poller-test-"));
  try {
    const path = NodePath.join(dir, "state.json");
    await saveJson(path, { before: true });
    await saveJson(path, { after: true });
    NodeAssert.deepEqual(JSON.parse(await NodeFSP.readFile(path, "utf8")), { after: true });
    NodeAssert.deepEqual(await NodeFSP.readdir(dir), ["state.json"]);
    const auth = NodePath.join(dir, "auth");
    await NodeFSP.writeFile(auth, "Bearer secret", { mode: 0o600 });
    NodeAssert.equal(await readAuthorization(auth), "Bearer secret");
    await NodeFSP.chmod(auth, 0o644);
    await NodeAssert.rejects(readAuthorization(auth), /private/);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
for (const sse of [false, true])
  NodeTest.test(
    `MCP handshake, reconnect identity, cleanup and tool errors (${sse ? "SSE" : "JSON"})`,
    async () => {
      const requests = [];
      const fetcher = async (_url, init) => {
        requests.push(init);
        if (init.method === "DELETE") return new Response(null, { status: 204 });
        const body = JSON.parse(init.body);
        if (!body.id) return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-06-18" }
            : body.params.name === "bad"
              ? { isError: true }
              : { structuredContent: { threadId: "worker" } };
        const json = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
        return new Response(sse ? `event: message\ndata: ${json}\n\n` : json, {
          headers: {
            "mcp-session-id": "session",
            "content-type": sse ? "text/event-stream" : "application/json",
          },
        });
      };
      const client = await mcpSession("http://localhost/mcp", "Bearer secret", fetcher);
      NodeAssert.deepEqual(await client.call("read", {}), { threadId: "worker" });
      await NodeAssert.rejects(client.call("bad", {}), /tool bad failed/);
      await client.close();
      NodeAssert.ok(requests.every((r) => r.headers.authorization === "Bearer secret"));
      NodeAssert.equal(requests.at(-1).method, "DELETE");
    },
  );

NodeTest.test(
  "real CLI + HTTP MCP + gh subprocess: read-only dry-run, dispatch, lock and crash recovery",
  async () => {
    const { createServer } = await import("node:http");
    const { spawn, execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { once } = await import("node:events");
    const { mkdir } = await import("node:fs/promises");
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "poller-e2e-"));
    const mutations = [];
    let requestCount = 0;
    const server = createServer(async (req, res) => {
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      requestCount++;
      NodeAssert.equal(req.headers.authorization, "Bearer fixture-only");
      if (!message.id) {
        res.writeHead(202).end();
        return;
      }
      let result;
      if (message.method === "initialize") result = { protocolVersion: "2025-06-18" };
      else {
        const { name, arguments: args } = message.params;
        if (["t3_thread_launch", "t3_thread_send"].includes(name)) {
          mutations.push({ name, args });
          result = { threadId: "fixture-worker" };
        } else if (name === "t3_thread_read")
          result = {
            thread: {
              projectId: "project",
              status: "running",
              latestRunId: "run",
              activeRunId: "run",
              pendingRequestCount: 0,
            },
          };
        else result = { project: { id: "project" } };
        result = { structuredContent: result };
      }
      res
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    let watcher;
    try {
      const bin = NodePath.join(dir, "bin");
      await mkdir(bin);
      await NodeFSP.writeFile(
        NodePath.join(bin, "gh"),
        `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(process.env.POLLER_FIXTURE_PID,String(process.ppid));const p=process.argv.at(-1);let r;if(p.endsWith('/releases/latest'))r={tag_name:'v1.1.0',target_commitish:'main',draft:false,prerelease:false};else if(p.includes('/git/ref/tags/')){const t=p.split('/tags/')[1];r={ref:'refs/tags/'+t,object:{type:'commit',sha:t==='v1.0.0'?'${a}':'${b}'}};}else if(p.includes('/commits/'))r={sha:'${c}'};else if(p.includes('/compare/'))r={status:'ahead'};else if(p.includes('/pulls?'))r=[];else r={};if(process.argv.includes('--slurp'))process.exit(1);if(process.argv.includes('--paginate')){for(const item of r)console.log(JSON.stringify(item));}else console.log(JSON.stringify(r));\n`,
        { mode: 0o700 },
      );
      const cfg = {
        ...config(),
        endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
        authorizationFile: NodePath.join(dir, "auth"),
        stateFile: NodePath.join(dir, "state.json"),
        intervalSeconds: 30,
      };
      await NodeFSP.writeFile(cfg.authorizationFile, "Bearer fixture-only\n", { mode: 0o600 });
      const configFile = NodePath.join(dir, "config.json");
      await NodeFSP.writeFile(configFile, JSON.stringify(cfg));
      const script = new URL("./local-release-poller.mjs", import.meta.url).pathname;
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        POLLER_FIXTURE_PID: NodePath.join(dir, "worker-pid"),
      };
      delete env.LOCAL_RELEASE_POLLER_LOCK;
      const run = (mode) =>
        promisify(execFile)(process.execPath, [script, mode, configFile], { env });
      await run("check");
      const dry = await run("dry-run");
      NodeAssert.match(dry.stdout, /Would start/);
      await NodeAssert.rejects(NodeFSP.readFile(cfg.stateFile), { code: "ENOENT" });
      NodeAssert.equal(mutations.length, 0);
      await run("once");
      NodeAssert.equal(mutations.length, 1);
      NodeAssert.equal(mutations[0].name, "t3_thread_launch");
      await run("once");
      NodeAssert.equal(mutations.length, 1);
      watcher = spawn(process.execPath, [script, "watch", configFile], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise((resolve, reject) => {
        watcher.stdout.once("data", resolve);
        watcher.once("error", reject);
        watcher.once("exit", (code) => reject(new Error(`watch exited ${code}`)));
      });
      await NodeAssert.rejects(run("once"), (error) => error.code === 73);
      const exited = once(watcher, "exit");
      const pid = Number(await NodeFSP.readFile(env.POLLER_FIXTURE_PID, "utf8"));
      NodeAssert.equal(
        pid,
        watcher.pid,
        "flock must replace the supervisor PID, not orphan a child",
      );
      process.kill(pid, "SIGKILL");
      await exited;
      watcher = null;
      await run("once");
      NodeAssert.equal(mutations.length, 1);
      NodeAssert.ok(requestCount > 5);
    } finally {
      if (watcher) {
        const exit = once(watcher, "exit");
        watcher.kill("SIGTERM");
        await exit;
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);

NodeTest.test("pairing approval uses PKCE and stores no token in stdout or arguments", async () => {
  const { authorize } = await import("./lib/local-release-auth.mjs");
  const { createHash } = await import("node:crypto");
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "poller-auth-"));
  try {
    const input = NodePath.join(dir, "pair");
    const output = NodePath.join(dir, "auth");
    await NodeFSP.writeFile(input, "Token: private-pairing-code\n", { mode: 0o600 });
    let auth;
    const fetcher = async (url, init) => {
      NodeAssert.equal(init.redirect, "error");
      if (url.endsWith("/register")) return Response.json({ client_id: "fixture-client" });
      if (url.endsWith("/decision")) {
        const payload = JSON.parse(init.body);
        auth = payload.authorization;
        NodeAssert.deepEqual(payload.decision, {
          _tag: "pairing-code",
          access: "full-access",
          code: "private-pairing-code",
        });
        return Response.json({
          redirectTo: `${auth.redirect_uri}?code=authorized-code&state=${auth.state}`,
        });
      }
      const form = new URLSearchParams(init.body);
      NodeAssert.equal(
        createHash("sha256").update(form.get("code_verifier")).digest("base64url"),
        auth.code_challenge,
      );
      return Response.json({
        token_type: "Bearer",
        access_token: "fixture-secret",
        expires_in: 100,
      });
    };
    NodeAssert.equal(await authorize("http://127.0.0.1/mcp", input, output, fetcher), 100);
    NodeAssert.equal(await readAuthorization(output), "Bearer fixture-secret");
    await NodeAssert.rejects(authorize("http://127.0.0.1/mcp", input, output, fetcher), {
      code: "EEXIST",
    });
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

NodeTest.test(
  "merge racing with injection credits the old published target, not the new request",
  async () => {
    const f = fixture();
    await f.run();
    f.data.latest = "v1.2.0";
    await f.run();
    NodeAssert.equal(f.state.active.target.sha, c);
    NodeAssert.deepEqual(f.state.active.superseded, [{ tag: "v1.1.0", sha: b }]);
    merged(f);
    await f.run();
    f.data.now += 11_000;
    await f.run();
    NodeAssert.equal(f.state.accepted.sha, b);
    NodeAssert.equal(f.state.active.target.sha, c);
    NodeAssert.equal(f.data.calls.filter((x) => x.tool === "t3_thread_launch").length, 2);
  },
);
NodeTest.test("never retarget an already merged PR while publication is pending", async () => {
  const f = fixture();
  await f.run();
  merged(f);
  f.data.status = "running";
  f.data.activeRunId = "run";
  f.data.latest = "v1.2.0";
  await f.run();
  NodeAssert.equal(f.state.desired.sha, c);
  NodeAssert.equal(f.state.active.target.sha, b);
  NodeAssert.equal(f.data.calls.filter((x) => x.tool === "t3_thread_send").length, 0);
});
NodeTest.test("busy injection dry-run changes neither state nor deliveries", async () => {
  const f = fixture();
  await f.run();
  const before = structuredClone(f.state);
  const saves = f.data.saves.length;
  f.data.latest = "v1.2.0";
  NodeAssert.match(await f.run({ dryRun: true }), /Would inject/);
  NodeAssert.deepEqual(f.state, before);
  NodeAssert.equal(f.data.saves.length, saves);
  NodeAssert.equal(f.data.calls.filter((x) => x.tool === "t3_thread_send").length, 0);
});
