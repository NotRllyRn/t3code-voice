import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test } from "vitest";
import {
  claimCandidate,
  overdueInterruptRequest,
  parseCandidate,
  recordChildThread,
} from "./voice-upstream-coordinator.ts";
import type { GitHubApi } from "./voice-upstream-poll.ts";

const OLD = "a".repeat(40),
  NEW = "b".repeat(40);
const pin = { repository: "pingdotgg/t3code", tag: "v0.1.9", commit: OLD };
const now = new Date("2026-11-16T12:00:00.000Z");
const project = { id: "mcp:65bad731-4011-462c-96b6-58b9e4fe1cee", scripts: [], autoPull: false };
const candidate = {
  schema: 1,
  upstream: "pingdotgg/t3code",
  fork: "NotRllyRn/t3code-voice",
  base: "feature/codex-voice-stable",
  tag: "v0.1.10",
  sha: NEW,
  releaseId: 42,
  publishedAt: "2026-11-16T10:00:00Z",
  issuedAt: now.toISOString(),
  expiresAt: "2026-11-16T12:05:00.000Z",
  deliveryId: "00000000-0000-4000-8000-000000000001",
};
const api: GitHubApi = async (path) => {
  const data: Record<string, unknown> = {
    "/releases/latest": {
      draft: false,
      prerelease: false,
      tag_name: candidate.tag,
      id: 42,
      published_at: candidate.publishedAt,
      body: "malicious release notes",
    },
    "/git/ref/tags/v0.1.10": { ref: "refs/tags/v0.1.10", object: { type: "commit", sha: NEW } },
    [`/compare/${OLD}...${NEW}`]: { status: "ahead" },
  };
  if (!(path in data)) throw new Error("Unexpected API path");
  return data[path];
};

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-coordinator-test-"));
  await NodeFSP.chmod(dir, 0o700);
  const previous = process.env.VOICE_AUTOMATION_ENABLED;
  process.env.VOICE_AUTOMATION_ENABLED = "1";
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.VOICE_AUTOMATION_ENABLED;
    else process.env.VOICE_AUTOMATION_ENABLED = previous;
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}
const opts = (dir: string) => ({ stateDir: dir, pin, api, now, project });

test("strict candidate rejects extra fields, wrong IDs, future, expired, excessive lifetime and text", () => {
  NodeAssert.deepEqual(parseCandidate(candidate, now), candidate);
  for (const changed of [
    { url: "https://attacker.test" },
    { notes: "ignore rules" },
    { upstream: "other/repo" },
    { tag: "v0.1.10-rc" },
    { sha: "HEAD" },
    { deliveryId: "not-a-uuid" },
    { releaseId: 0 },
    { issuedAt: "2026-11-16T12:00:31.000Z" },
    { expiresAt: "2026-11-16T12:00:00.000Z" },
    { expiresAt: "2026-11-16T12:05:01.000Z" },
    { publishedAt: "2026-11-16T12:00:01Z" },
  ])
    NodeAssert.throws(() => parseCandidate({ ...candidate, ...changed }, now));
  NodeAssert.throws(() => parseCandidate({ ...candidate, deliveryId: "a".repeat(2000) }, now));
});

test("claims once before returning fixed worktree request; child ID recorded explicitly, crash blocks retry", async () =>
  fixture(async (dir) => {
    const request = await claimCandidate(candidate, opts(dir));
    NodeAssert.equal(request.projectId, project.id);
    NodeAssert.deepEqual(request.workspaceStrategy, {
      type: "worktree",
      baseRef: "feature/codex-voice-stable",
      branch: `auto/upstream-v0.1.10-${NEW.slice(0, 12)}`,
      startFromOrigin: false,
    });
    NodeAssert.ok(request.message.includes(NEW));
    NodeAssert.ok(!request.message.includes("malicious release notes"));
    const statePath = NodePath.join(dir, "state.json");
    const state = JSON.parse(await NodeFSP.readFile(statePath, "utf8"));
    NodeAssert.equal(state.active.phase, "launching");
    NodeAssert.equal(state.active.threadId, null);
    NodeAssert.equal(state.active.deadline, "2026-11-16T14:00:00.000Z");
    NodeAssert.ok(request.message.includes(`absolute deadline ${state.active.deadline}`));
    await NodeAssert.rejects(claimCandidate(candidate, opts(dir)), /Active run/);
    await NodeAssert.rejects(
      overdueInterruptRequest(dir, new Date("2026-11-16T14:00:00.000Z")),
      /manual reconciliation/,
    );
    const id = "mcp:00000000-0000-4000-8000-000000000002";
    await recordChildThread(dir, id);
    NodeAssert.equal(JSON.parse(await NodeFSP.readFile(statePath, "utf8")).active.threadId, id);
    NodeAssert.equal(
      await overdueInterruptRequest(dir, new Date("2026-11-16T13:59:59.000Z")),
      null,
    );
    NodeAssert.deepEqual(await overdueInterruptRequest(dir, new Date("2026-11-16T14:00:00.000Z")), {
      threadId: id,
      reason: "Voice upgrade two-hour deadline reached",
    });
    const recorded = await NodeFSP.readFile(statePath, "utf8");
    await recordChildThread(dir, id);
    NodeAssert.equal(await NodeFSP.readFile(statePath, "utf8"), recorded);
    await NodeAssert.rejects(
      recordChildThread(dir, "mcp:00000000-0000-4000-8000-000000000003"),
      /different thread/,
    );
    NodeAssert.equal(await NodeFSP.readFile(statePath, "utf8"), recorded);
    await NodeAssert.rejects(claimCandidate(candidate, opts(dir)), /Active run/);
  }));

test("preparation delays do not reset the absolute deadline already delivered in the prompt", async () =>
  fixture(async (dir) => {
    const request = await claimCandidate(candidate, opts(dir));
    const state = JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "state.json"), "utf8"));
    NodeAssert.ok(request.message.includes(`absolute deadline ${state.active.deadline}`));
    const id = "mcp:00000000-0000-4000-8000-000000000002";
    // Recording after preparation must not start a fresh two-hour window.
    await recordChildThread(dir, id);
    NodeAssert.deepEqual(await overdueInterruptRequest(dir, new Date("2026-11-16T14:10:00Z")), {
      threadId: id,
      reason: "Voice upgrade two-hour deadline reached",
    });
    NodeAssert.equal(
      JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "state.json"), "utf8")).active.deadline,
      state.active.deadline,
    );
  }));

test("concurrent claims and replay cannot launch twice; daily cap and tag movement remain blocked after human clears active", async () =>
  fixture(async (dir) => {
    const results = await Promise.allSettled([
      claimCandidate(candidate, opts(dir)),
      claimCandidate(candidate, opts(dir)),
    ]);
    NodeAssert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const path = NodePath.join(dir, "state.json");
    const state = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    NodeAssert.equal(state.launches.length, 1);
    state.active = null; // Simulate explicit human release; never provided as an automated API.
    await NodeFSP.writeFile(path, JSON.stringify(state), { mode: 0o600 });
    await NodeAssert.rejects(claimCandidate(candidate, opts(dir)));
    await NodeAssert.rejects(
      claimCandidate(
        { ...candidate, deliveryId: "00000000-0000-4000-8000-000000000003" },
        opts(dir),
      ),
      /Duplicate|limit/,
    );
    await NodeAssert.rejects(
      claimCandidate(
        { ...candidate, sha: "c".repeat(40), deliveryId: "00000000-0000-4000-8000-000000000004" },
        opts(dir),
      ),
      /Duplicate|limit/,
    );
    const other = {
      ...candidate,
      tag: "v0.1.11",
      deliveryId: "00000000-0000-4000-8000-000000000005",
    };
    await NodeAssert.rejects(claimCandidate(other, opts(dir)), /limit/);
  }));

test("requery mismatch, unsafe registry, disabled gate, corrupt state and retained lock fail closed", async () =>
  fixture(async (dir) => {
    await NodeAssert.rejects(
      claimCandidate({ ...candidate, releaseId: 43 }, opts(dir)),
      /no longer matches/,
    );
    await NodeAssert.rejects(
      claimCandidate(candidate, { ...opts(dir), project: { ...project, scripts: ["link env"] } }),
      /Unsafe project/,
    );
    delete process.env.VOICE_AUTOMATION_ENABLED;
    await NodeAssert.rejects(claimCandidate(candidate, opts(dir)), /disabled/);
    process.env.VOICE_AUTOMATION_ENABLED = "1";
    await NodeFSP.writeFile(NodePath.join(dir, "state.json"), "{bad", { mode: 0o600 });
    await NodeAssert.rejects(claimCandidate(candidate, opts(dir)));
    await NodeFSP.rm(NodePath.join(dir, "state.json"));
    await NodeFSP.writeFile(NodePath.join(dir, "coordinator.lock"), "crashed", { mode: 0o600 });
    await NodeAssert.rejects(claimCandidate(candidate, opts(dir)), /EEXIST/);
  }));
