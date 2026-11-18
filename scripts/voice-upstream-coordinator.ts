#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Native file locking and ISO timestamps are shared with the dependency-free Node coordinator.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  pollUpstream,
  validatePin,
  type Candidate,
  type GitHubApi,
} from "./lib/voice-upstream-poll.ts";

const PROJECT = "mcp:65bad731-4011-462c-96b6-58b9e4fe1cee";
const BASE = "feature/codex-voice-stable";
const KEYS = [
  "schema",
  "upstream",
  "fork",
  "base",
  "tag",
  "sha",
  "releaseId",
  "publishedAt",
  "issuedAt",
  "expiresAt",
  "deliveryId",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const T3_THREAD_ID = /^mcp:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LAUNCH_THREAD_ID = /^mcp:launch:[0-9a-f]{64}$/;
const MAX_CANDIDATE_BYTES = 1024;
const DAY = 86_400_000;
const LIMIT = 300_000;

type Active = {
  tag: string;
  sha: string;
  releaseId: number;
  branch: string;
  phase: "launching" | "launched";
  threadId: string | null;
  claimedAt: string;
  deadline: string;
};
type State = {
  schema: 1;
  active: Active | null;
  launches: string[];
  identities: string[];
  deliveries: string[];
};
export type LaunchRequest = {
  projectId: string;
  title: string;
  workspaceStrategy: {
    type: "worktree";
    baseRef: typeof BASE;
    branch: string;
    startFromOrigin: false;
  };
  message: string;
};

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !== [...keys].sort().join("|")
  )
    throw new Error("Invalid exact-key object");
  return value as Record<string, unknown>;
}
function time(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Invalid timestamp");
  const canonical = new Date(Date.parse(value)).toISOString();
  if (value !== canonical && value !== canonical.replace(".000Z", "Z"))
    throw new Error("Noncanonical timestamp");
  return Date.parse(value);
}
export function parseCandidate(input: unknown, now: Date): Candidate {
  if (
    !Number.isFinite(now.getTime()) ||
    Buffer.byteLength(JSON.stringify(input) ?? "", "utf8") > MAX_CANDIDATE_BYTES
  )
    throw new Error("Invalid candidate size or clock");
  const c = exact(input, KEYS);
  if (
    c.schema !== 1 ||
    c.upstream !== "pingdotgg/t3code" ||
    c.fork !== "NotRllyRn/t3code-voice" ||
    c.base !== BASE ||
    typeof c.tag !== "string" ||
    !TAG.test(c.tag) ||
    c.tag.length > 80 ||
    typeof c.sha !== "string" ||
    !SHA.test(c.sha) ||
    !Number.isSafeInteger(c.releaseId) ||
    (c.releaseId as number) <= 0 ||
    typeof c.deliveryId !== "string" ||
    !UUID.test(c.deliveryId)
  )
    throw new Error("Invalid candidate identity");
  const published = time(c.publishedAt),
    issued = time(c.issuedAt),
    expires = time(c.expiresAt);
  if (
    published > issued ||
    issued > now.getTime() + 30_000 ||
    expires <= now.getTime() ||
    expires <= issued ||
    expires > issued + LIMIT
  )
    throw new Error("Expired or future candidate");
  return c as Candidate;
}

function decodeState(input: unknown): State {
  const s = exact(input, ["schema", "active", "launches", "identities", "deliveries"]);
  if (
    s.schema !== 1 ||
    !Array.isArray(s.launches) ||
    !Array.isArray(s.identities) ||
    !Array.isArray(s.deliveries) ||
    !s.launches.every((v) => typeof v === "string" && Number.isFinite(time(v))) ||
    !s.identities.every((v) => typeof v === "string" && /^v\d+\.\d+\.\d+:[a-f0-9]{40}$/.test(v)) ||
    !s.deliveries.every((v) => typeof v === "string" && UUID.test(v))
  )
    throw new Error("Corrupt coordinator state");
  if (s.active !== null) {
    const a = exact(s.active, [
      "tag",
      "sha",
      "releaseId",
      "branch",
      "phase",
      "threadId",
      "claimedAt",
      "deadline",
    ]);
    if (
      typeof a.tag !== "string" ||
      !TAG.test(a.tag) ||
      typeof a.sha !== "string" ||
      !SHA.test(a.sha) ||
      !Number.isSafeInteger(a.releaseId) ||
      (a.releaseId as number) <= 0 ||
      a.branch !== branch(a.tag, a.sha) ||
      !["launching", "launched"].includes(a.phase as string) ||
      (a.phase === "launching"
        ? a.threadId !== null
        : typeof a.threadId !== "string" ||
          !(T3_THREAD_ID.test(a.threadId) || LAUNCH_THREAD_ID.test(a.threadId))) ||
      time(a.deadline) !== time(a.claimedAt) + 7_200_000
    )
      throw new Error("Corrupt active run");
  }
  return s as State;
}
function branch(tag: string, sha: string): string {
  return `auto/upstream-${tag}-${sha.slice(0, 12)}`;
}
function inside(path: string, parent: string): boolean {
  const rel = NodePath.relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !NodePath.isAbsolute(rel));
}
async function privateDir(dir: string): Promise<string> {
  if (!NodePath.isAbsolute(dir)) throw new Error("State directory must be absolute");
  const path = await NodeFSP.realpath(dir);
  const info = await NodeFSP.stat(path);
  const repo = await NodeFSP.realpath(NodePath.resolve(import.meta.dirname, ".."));
  const home = process.env.HOME ? await NodeFSP.realpath(process.env.HOME) : null;
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    inside(path, repo) ||
    (home && inside(path, NodePath.join(home, ".t3")))
  )
    throw new Error("State directory must be private and outside repo and live T3");
  return path;
}
async function save(dir: string, state: State): Promise<void> {
  const temp = NodePath.join(dir, `.state-${NodeCrypto.randomUUID()}`);
  try {
    const output = await NodeFSP.open(temp, "wx", 0o600);
    try {
      await output.writeFile(JSON.stringify(state) + "\n");
      await output.sync();
    } finally {
      await output.close();
    }
    await NodeFSP.rename(temp, NodePath.join(dir, "state.json"));
    const handle = await NodeFSP.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await NodeFSP.unlink(temp).catch(() => undefined);
  }
}
async function locked<T>(
  dirInput: string,
  operation: (dir: string, state: State) => Promise<T>,
): Promise<T> {
  const dir = await privateDir(dirInput);
  const lock = NodePath.join(dir, "coordinator.lock");
  const handle = await NodeFSP.open(lock, "wx", 0o600); // A crash leaves this lock for human reconciliation; never age it out.
  try {
    const path = NodePath.join(dir, "state.json");
    let state: State;
    try {
      const info = await NodeFSP.lstat(path);
      if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("Unsafe state file");
      state = decodeState(JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { schema: 1, active: null, launches: [], identities: [], deliveries: [] };
    }
    return await operation(dir, state);
  } finally {
    await handle.close();
    await NodeFSP.unlink(lock);
  }
}

export function voiceUpgradeWorkerPrompt(
  candidate: Pick<Candidate, "tag" | "sha">,
  deadline: string,
): string {
  time(deadline);
  return `Upgrade the voice fork against the verified upstream stable ${candidate.tag} commit ${candidate.sha}. Keep the target immutable. Preserve fork behavior; review migrations, compatibility, and the diff. Open an early progress PR against ${BASE} only after an independently reviewed meaningful commit. Stop for human approval before merge. Never publish, deploy, or change a live service. Stop your own work at the absolute deadline ${deadline} and request operator reconciliation; do not wait for cancellation. The external coordinator's two-hour audit is best-effort and may be delayed while the app is offline. It requests a current-turn interrupt, not guaranteed cancellation of queued turns or nested work; this is not a hard runtime cap. Do not merge, publish, or deploy.`;
}

export async function claimCandidate(
  input: unknown,
  opts: {
    stateDir: string;
    pin: unknown;
    api: GitHubApi;
    now: Date;
    project: { id: string; scripts: readonly unknown[]; autoPull: boolean };
    authorizedProjectId?: string;
    beforeClaim?: () => Promise<Date>;
  },
): Promise<LaunchRequest> {
  if (process.env.VOICE_AUTOMATION_ENABLED !== "1") throw new Error("Voice automation disabled");
  const candidate = parseCandidate(input, opts.now);
  const pin = validatePin(opts.pin);
  if (
    opts.project.id !== (opts.authorizedProjectId ?? PROJECT) ||
    opts.project.autoPull !== false ||
    !Array.isArray(opts.project.scripts) ||
    opts.project.scripts.length !== 0
  )
    throw new Error("Unsafe project registry configuration");
  return locked(opts.stateDir, async (dir, state) => {
    if (state.active)
      throw new Error("Active run requires explicit human release or reconciliation");
    const identity = `${candidate.tag}:${candidate.sha}`;
    if (
      state.deliveries.includes(candidate.deliveryId) ||
      state.identities.includes(identity) ||
      state.identities.some((v) => v.startsWith(`${candidate.tag}:`))
    )
      throw new Error("Duplicate delivery or moved/claimed tag");
    if (state.launches.some((t) => time(t) > opts.now.getTime() - DAY))
      throw new Error("Rolling 24-hour launch limit");
    const verified = await pollUpstream(pin, opts.api, opts.now, candidate.deliveryId);
    if (
      !verified ||
      verified.releaseId !== candidate.releaseId ||
      verified.tag !== candidate.tag ||
      verified.sha !== candidate.sha ||
      verified.publishedAt !== candidate.publishedAt
    )
      throw new Error("Release no longer matches independent GitHub check");
    const claimNow = opts.beforeClaim ? await opts.beforeClaim() : opts.now;
    parseCandidate(candidate, claimNow);
    const claimedAt = claimNow.toISOString();
    const branchName = branch(candidate.tag, candidate.sha);
    state.active = {
      tag: candidate.tag,
      sha: candidate.sha,
      releaseId: candidate.releaseId,
      branch: branchName,
      phase: "launching",
      threadId: null,
      claimedAt,
      deadline: new Date(claimNow.getTime() + 7_200_000).toISOString(),
    };
    state.launches.push(claimedAt);
    state.identities.push(identity);
    state.deliveries.push(candidate.deliveryId);
    await save(dir, state);
    return {
      projectId: opts.project.id,
      title: `Upgrade voice fork to ${candidate.tag}`,
      workspaceStrategy: {
        type: "worktree",
        baseRef: BASE,
        branch: branchName,
        startFromOrigin: false,
      },
      message: voiceUpgradeWorkerPrompt(candidate, state.active.deadline),
    };
  });
}

export async function overdueInterruptRequest(
  stateDir: string,
  now: Date,
): Promise<{ threadId: string; reason: string } | null> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid clock");
  return locked(stateDir, async (_dir, state) => {
    if (!state.active || now.getTime() < time(state.active.deadline)) return null;
    if (!state.active.threadId)
      throw new Error("Expired launch has no recorded thread: manual reconciliation required");
    return {
      threadId: state.active.threadId,
      reason: "Voice upgrade two-hour deadline reached",
    };
  });
}

export async function recordChildThread(stateDir: string, threadId: string): Promise<void> {
  if (!(T3_THREAD_ID.test(threadId) || LAUNCH_THREAD_ID.test(threadId)))
    throw new Error("Invalid thread ID");
  await locked(stateDir, async (dir, state) => {
    if (!state.active) throw new Error("No launch to reconcile");
    if (state.active.phase === "launched") {
      if (state.active.threadId !== threadId)
        throw new Error("Launch already records a different thread");
      return;
    }
    state.active.phase = "launched";
    state.active.threadId = threadId;
    await save(dir, state);
  });
}
