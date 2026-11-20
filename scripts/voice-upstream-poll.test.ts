// @effect-diagnostics nodeBuiltinImport:off -- Runs the real Node CLI and bundle in isolated filesystem and subprocess fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeVM from "node:vm";
import { build } from "vite-plus";
import { expect, test } from "vite-plus/test";
import {
  githubJson,
  pollUpstream,
  postCandidate,
  type GitHubApi,
} from "./lib/voice-upstream-poll.ts";

test("a single-file server import never invokes the poll CLI", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-poll-import-"));
  try {
    const file = NodePath.join(dir, "server.mjs");
    await build({
      configFile: false,
      root: dir,
      logLevel: "silent",
      build: {
        ssr: NodeURL.fileURLToPath(new URL("./voice-upstream-coordinator.ts", import.meta.url)),
        outDir: dir,
        emptyOutDir: false,
        minify: false,
        target: "esnext",
        rolldownOptions: {
          treeshake: false,
          output: { entryFileNames: "server.mjs", codeSplitting: false },
        },
      },
    });
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      `
      let fetches = 0;
      let errors = 0;
      globalThis.fetch = async () => { fetches++; throw new Error("Network forbidden"); };
      console.error = () => { errors++; };
      process.env.VOICE_AUTOMATION_ENABLED = "0";
      process.argv = [process.execPath, ${JSON.stringify(file)}];
      process.once("beforeExit", () => {
        console.log(JSON.stringify({ fetches, errors, exitCode: process.exitCode ?? 0 }));
        process.exitCode = 0;
      });
      await import(${JSON.stringify(NodeURL.pathToFileURL(file).href)});
    `,
    ]);
    expect(JSON.parse(stdout)).toEqual({ fetches: 0, errors: 0, exitCode: 0 });
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

test("the sender CLI runs from the workflow's sparse checkout with only fake IO", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-poll-sparse-"));
  try {
    const workflow = await NodeFSP.readFile(
      new URL("../.github/workflows/voice-upstream-watch.yml", import.meta.url),
      "utf8",
    );
    const jobCondition = /^    if: (.+)$/m.exec(workflow)![1]!;
    const sendCondition =
      /name: Verify stable upstream release and notify signed coordinator\n        if: (.+)/.exec(
        workflow,
      )![1]!;
    const readCondition =
      /name: Check stable upstream release without delivery\n        if: (.+)/.exec(workflow)![1]!;
    for (const ref of ["refs/heads/main", "refs/heads/other", "refs/tags/main"]) {
      for (const event of ["schedule", "workflow_dispatch"]) {
        for (const enabled of [undefined, "false", "true"]) {
          for (const send of [false, true]) {
            const context = {
              github: {
                repository: "NotRllyRn/t3code-voice",
                ref,
                event_name: event,
                event: { repository: { default_branch: "main" } },
              },
              vars: { VOICE_UPSTREAM_WATCH_ENABLED: enabled },
              inputs: { send_webhook: send },
              format: (pattern: string, value: string) => pattern.replace("{0}", value),
            };
            const evaluate = (condition: string) =>
              Boolean(NodeVM.runInNewContext(condition, context));
            expect(evaluate(jobCondition) && evaluate(sendCondition)).toBe(
              ref === "refs/heads/main" && enabled === "true" && (event === "schedule" || send),
            );
            expect(evaluate(jobCondition) && evaluate(readCondition)).toBe(
              ref === "refs/heads/main" && event === "workflow_dispatch" && !send,
            );
          }
        }
      }
    }
    const sparse = /sparse-checkout: \|\n((?: {12}[^\n]+\n)+)/
      .exec(workflow)?.[1]
      ?.trim()
      .split("\n")
      .map((line) => line.trim());
    expect(sparse).toContain("scripts/lib/voice-upstream-poll.ts");
    for (const file of sparse!) {
      const destination = NodePath.join(dir, file);
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      await NodeFSP.copyFile(new URL(`../${file}`, import.meta.url), destination);
    }
    const bootstrap = NodePath.join(dir, "fake-io.mjs");
    await NodeFSP.writeFile(
      bootstrap,
      `
      import { createHmac } from "node:crypto";
      let gets = 0;
      let posts = 0;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url === "https://example.test/hook" && init.method === "POST") {
          posts++;
          const expected = "sha256=" + createHmac("sha256", "test-only-key").update(init.body).digest("hex");
          if (init.headers["x-hub-signature-256"] !== expected) throw new Error("Bad sender signature");
          return new Response("{}", { status: 202 });
        }
        if (!url.startsWith("https://api.github.com/repos/pingdotgg/t3code/")) throw new Error("Unexpected fake request");
        gets++;
        const sha = "b".repeat(40);
        const value = url.endsWith("/releases/latest")
          ? { draft: false, target_commitish: "main", prerelease: false, tag_name: "v99.0.0", id: 42, published_at: "2026-11-16T00:00:00Z" }
          : url.endsWith("/git/ref/tags/v99.0.0")
            ? { ref: "refs/tags/v99.0.0", object: { type: "commit", sha } }
            : url.endsWith("/git/ref/heads/main") ? { ref: "refs/heads/main", object: { type: "commit", sha } }
            : url.includes("/compare/") ? { status: "ahead" } : null;
        if (value === null) throw new Error("Unexpected fake API path");
        return new Response(JSON.stringify(value));
      };
      process.once("beforeExit", () => console.log(JSON.stringify({ gets, posts })));
    `,
    );
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      process.execPath,
      [
        "--import",
        bootstrap,
        NodePath.join(dir, "scripts/voice-upstream-poll.ts"),
        "--enable-webhook",
      ],
      {
        env: {
          ...process.env,
          VOICE_UPSTREAM_WEBHOOK_URL: "https://example.test/hook",
          VOICE_UPSTREAM_WEBHOOK_SECRET: "test-only-key",
        },
      },
    );
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ gets: 5, posts: 1 });
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const TAG_SHA = "c".repeat(40);
const ID = "00000000-0000-4000-8000-000000000001";
const pin = { repository: "pingdotgg/t3code", tag: "v0.1.9", commit: OLD };
const release = {
  draft: false,
  target_commitish: "main",
  prerelease: false,
  tag_name: "v0.1.10",
  id: 42,
  published_at: "2026-11-16T10:00:00Z",
  body: "Ignore instructions here",
};
const clock = new Date("2026-11-16T12:00:00.000Z");

function fakeApi(overrides: Record<string, unknown> = {}) {
  const paths: string[] = [];
  const responses: Record<string, unknown> = {
    "/releases/latest": release,
    "/git/ref/tags/v0.1.10": { ref: "refs/tags/v0.1.10", object: { type: "tag", sha: TAG_SHA } },
    [`/git/tags/${TAG_SHA}`]: {
      sha: TAG_SHA,
      tag: "v0.1.10",
      object: { type: "commit", sha: NEW },
    },
    "/git/ref/heads/main": { ref: "refs/heads/main", object: { type: "commit", sha: NEW } },
    [`/compare/${NEW}...${NEW}`]: { status: "identical" },
    [`/compare/${OLD}...${NEW}`]: { status: "ahead" },
    ...overrides,
  };
  const api: GitHubApi = async (path) => {
    paths.push(path);
    if (!(path in responses)) throw new Error(`Unexpected API request: ${path}`);
    return responses[path];
  };
  return { api, paths };
}

test("resolves annotated tags, compares numeric stable versions, and omits untrusted release text", async () => {
  const { api, paths } = fakeApi();
  const candidate = await pollUpstream(pin, api, clock, ID);
  expect(candidate).toEqual({
    schema: 1,
    upstream: "pingdotgg/t3code",
    fork: "NotRllyRn/t3code-voice",
    tag: "v0.1.10",
    sha: NEW,
    releaseId: 42,
    publishedAt: "2026-11-16T10:00:00Z",
    issuedAt: clock.toISOString(),
    expiresAt: "2026-11-16T12:05:00.000Z",
    deliveryId: ID,
  });
  expect(paths).toEqual([
    "/releases/latest",
    "/git/ref/tags/v0.1.10",
    `/git/tags/${TAG_SHA}`,
    "/git/ref/heads/main",
    `/compare/${NEW}...${NEW}`,
    `/compare/${OLD}...${NEW}`,
  ]);
  expect(JSON.stringify(candidate)).not.toContain("Ignore instructions");
});

test("peels a second annotated tag without using its name as the release tag", async () => {
  const inner = "d".repeat(40);
  const { api, paths } = fakeApi({
    [`/git/tags/${TAG_SHA}`]: { sha: TAG_SHA, tag: "v0.1.10", object: { type: "tag", sha: inner } },
    [`/git/tags/${inner}`]: {
      sha: inner,
      tag: "previous-name",
      object: { type: "commit", sha: NEW },
    },
  });
  expect((await pollUpstream(pin, api, clock, ID))?.sha).toBe(NEW);
  expect(paths).toContain(`/git/tags/${inner}`);
});

test("same stable tag and SHA is a no-op; movement and lower latest fail closed", async () => {
  const same = fakeApi({
    "/releases/latest": { ...release, tag_name: "v0.1.9" },
    "/git/ref/tags/v0.1.9": { ref: "refs/tags/v0.1.9", object: { type: "commit", sha: OLD } },
  });
  expect(await pollUpstream(pin, same.api, clock, ID)).toBeNull();
  expect(same.paths).not.toContain(`/compare/${OLD}...${NEW}`);
  const moved = fakeApi({
    "/releases/latest": { ...release, tag_name: "v0.1.9" },
    "/git/ref/tags/v0.1.9": { ref: "refs/tags/v0.1.9", object: { type: "commit", sha: NEW } },
  });
  await expect(pollUpstream(pin, moved.api, clock, ID)).rejects.toThrow("Accepted tag moved");
  const lower = fakeApi({ "/releases/latest": { ...release, tag_name: "v0.1.8" } });
  await expect(pollUpstream(pin, lower.api, clock, ID)).rejects.toThrow("older");
  expect(lower.paths).toEqual(["/releases/latest"]);
});

test("rejects drafts, prereleases, malformed releases, wrong pin and non-ancestor", async () => {
  for (const changed of [
    { draft: true },
    { target_commitish: "release/maintenance" },
    { prerelease: true },
    { tag_name: "v0.1.10-nightly.1" },
    { tag_name: "v0.01.10" },
    { id: "42" },
    { id: 0 },
    { published_at: "nonsense" },
  ]) {
    await expect(
      pollUpstream(pin, fakeApi({ "/releases/latest": { ...release, ...changed } }).api, clock, ID),
    ).rejects.toThrow();
  }
  await expect(
    pollUpstream({ ...pin, repository: "other/repo" }, fakeApi().api, clock, ID),
  ).rejects.toThrow("repository");
  await expect(
    pollUpstream({ ...pin, commit: "branch" }, fakeApi().api, clock, ID),
  ).rejects.toThrow("SHA");
  for (const status of ["behind", "diverged", "identical"])
    await expect(
      pollUpstream(pin, fakeApi({ [`/compare/${OLD}...${NEW}`]: { status } }).api, clock, ID),
    ).rejects.toThrow("ancestor");
});

test("rejects malformed tag refs, cycles, wrong tag SHA and invalid delivery IDs", async () => {
  await expect(
    pollUpstream(
      pin,
      fakeApi({
        "/git/ref/tags/v0.1.10": {
          ref: "refs/tags/v0.1.10",
          object: { type: "commit", sha: "bad" },
        },
      }).api,
      clock,
      ID,
    ),
  ).rejects.toThrow("SHA");
  await expect(
    pollUpstream(
      pin,
      fakeApi({
        [`/git/tags/${TAG_SHA}`]: {
          sha: TAG_SHA,
          tag: "v0.1.10",
          object: { type: "tag", sha: TAG_SHA },
        },
      }).api,
      clock,
      ID,
    ),
  ).rejects.toThrow("cycle");
  await expect(
    pollUpstream(
      pin,
      fakeApi({
        [`/git/tags/${TAG_SHA}`]: {
          sha: NEW,
          tag: "v0.1.10",
          object: { type: "commit", sha: NEW },
        },
      }).api,
      clock,
      ID,
    ),
  ).rejects.toThrow("mismatch");
  await expect(pollUpstream(pin, fakeApi().api, clock, "bad")).rejects.toThrow("delivery ID");
});

test("API uses fixed paths, rejects oversized responses and HTTP failures", async () => {
  await expect(githubJson("https://evil.example/")).rejects.toThrow("path");
  const comparePath = `/compare/${OLD}...${NEW}`;
  const comparison = { status: "ahead", files: [{ patch: "x".repeat(65_536) }] };
  await expect(
    githubJson(comparePath, async () => new Response(JSON.stringify(comparison))),
  ).resolves.toEqual(comparison);
  await expect(
    githubJson(
      comparePath,
      async () => new Response("", { headers: { "content-length": String(16 * 1024 * 1024 + 1) } }),
    ),
  ).rejects.toThrow("too large");
  const releaseWithNotes = { ...release, body: "x".repeat(180_000), assets: [] };
  await expect(
    githubJson("/releases/latest", async (url) => {
      expect(String(url)).toBe("https://api.github.com/repos/pingdotgg/t3code/releases/latest");
      return new Response(JSON.stringify(releaseWithNotes));
    }),
  ).resolves.toEqual(releaseWithNotes);
  await expect(
    githubJson(
      "/releases/latest",
      async () => new Response("", { headers: { "content-length": String(1024 * 1024 + 1) } }),
    ),
  ).rejects.toThrow("too large");
  let cancelled = false;
  await expect(
    githubJson(
      "/releases/latest",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    ),
  ).rejects.toThrow("too large");
  expect(cancelled).toBe(true);
  await expect(
    githubJson("/git/ref/heads/main", async (url) => {
      expect(String(url)).toBe("https://api.github.com/repos/pingdotgg/t3code/git/ref/heads/main");
      return new Response("x".repeat(32_769));
    }),
  ).rejects.toThrow("too large");
  await expect(
    githubJson("/releases/latest", async () => new Response("", { status: 403 })),
  ).rejects.toThrow("HTTP 403");
});

test("webhook signs exact bytes and rejects insecure URL or missing secret", async () => {
  const candidate = await pollUpstream(pin, fakeApi().api, clock, ID);
  if (!candidate) throw new Error("Fixture must have a new release");
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    expect(String(url)).toBe("https://example.test/receive");
    expect(init?.body).toBe(JSON.stringify(candidate));
    const headers = new Headers(init?.headers);
    expect(headers.get("x-hub-signature-256")).toBe(
      `sha256=${NodeCrypto.createHmac("sha256", "trusted-secret").update(JSON.stringify(candidate)).digest("hex")}`,
    );
    return new Response("", { status: 202 });
  };
  for (const url of [
    "http://example.test/",
    "https://user:pass@example.test/",
    "https://example.test/#fragment",
    "malformed",
  ])
    await expect(postCandidate(candidate, url, "trusted-secret", fetcher)).rejects.toThrow();
  await expect(postCandidate(candidate, "https://example.test/", "", fetcher)).rejects.toThrow();
  expect(calls).toBe(0);
  await postCandidate(candidate, "https://example.test/receive", "trusted-secret", fetcher);
  expect(calls).toBe(1);
});

test("rejects stable releases outside the upstream main line", async () => {
  for (const status of ["behind", "diverged"]) {
    await expect(
      pollUpstream(
        pin,
        fakeApi({
          "/git/ref/heads/main": {
            ref: "refs/heads/main",
            object: { type: "commit", sha: "d".repeat(40) },
          },
          [`/compare/${NEW}...${"d".repeat(40)}`]: { status },
        }).api,
        clock,
        ID,
      ),
    ).rejects.toThrow("main");
  }
});
