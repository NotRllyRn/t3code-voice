#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { FORK_RELEASE } from "../packages/shared/src/forkIdentity.ts";
import {
  claimCandidate,
  overdueInterruptRequest,
  parseCandidate,
  recordChildThread,
} from "./voice-upstream-coordinator.ts";
import { githubJson, type GitHubApi } from "./lib/voice-upstream-poll.ts";

// Webhook JSON is data: use structured stdin/file input, never shell interpolation.
// Managed scheduler verifies HMAC before that prompt; this CLI is not an HTTP/signature verifier.
// A separate bound periodic prompt invokes `audit <state-dir>`; offline audits miss deadlines.
const PROJECT = "mcp:65bad731-4011-462c-96b6-58b9e4fe1cee";
const THREAD_ID = /^mcp:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LAUNCH_THREAD_ID = /^mcp:launch:[0-9a-f]{64}$/;
const VOICE_MODEL = "codex-broker/gpt-6.1-sol";
type Thinking = "medium" | "provider_default";
const MAX_RESPONSE = 65_536;
const TOOL_TIMEOUT = 30_000;
const CLEAN_PROVIDER_CONSTRAINT = {
  instanceId: "voice-automation",
  driver: "pi",
  environmentMode: "clean",
} as const;

type ToolName =
  | "orchestrator_capabilities"
  | "t3_project_read"
  | "t3_thread_launch"
  | "t3_thread_read"
  | "t3_thread_configure"
  | "t3_thread_interrupt";
export type T3ToolTransport = (
  tool: ToolName,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
type Options = {
  stateDir: string;
  transport: T3ToolTransport;
  now?: Date;
  api?: GitHubApi;
  pin?: unknown;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid T3 tool object");
  return value as Record<string, unknown>;
}
function enabled(): void {
  if (process.env.VOICE_AUTOMATION_ENABLED !== "1") throw new Error("Voice automation disabled");
}
async function call(
  transport: T3ToolTransport,
  tool: ToolName,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Buffer.byteLength(JSON.stringify(args)) > 16_384) throw new Error("T3 request too large");
  const signal = AbortSignal.timeout(TOOL_TIMEOUT);
  let onAbort: (() => void) | undefined;
  try {
    const value = await Promise.race([
      transport(tool, args, signal),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("T3 tool timed out; reconcile before retrying"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_RESPONSE)
      throw new Error("T3 response too large");
    const result = object(value);
    if (result.isError === true || "error" in result) throw new Error("T3 tool returned failure");
    return result;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function isVoiceSelection(value: unknown, thinking: Thinking): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = object(value);
  if (selection.instanceId !== "voice-automation" || selection.model !== VOICE_MODEL) return false;
  const options = selection.options;
  if (thinking === "provider_default")
    return (
      options === undefined ||
      (Array.isArray(options) && options.length === 0) ||
      (!!options && typeof options === "object" && Object.keys(options).length === 0)
    );
  if (Array.isArray(options)) {
    if (options.length !== 1) return false;
    const option = options[0];
    return (
      !!option &&
      typeof option === "object" &&
      !Array.isArray(option) &&
      Object.keys(option).length === 2 &&
      option.id === "thinking" &&
      option.value === "medium"
    );
  }
  return (
    !!options &&
    typeof options === "object" &&
    Object.keys(options).length === 1 &&
    object(options).thinking === "medium"
  );
}

export async function launchCandidate(input: unknown, opts: Options) {
  enabled();
  const now = opts.now ?? new Date();
  const candidate = parseCandidate(input, now);
  const thinking = await requireSafeProvider(opts.transport);
  const project = await call(opts.transport, "t3_project_read", { projectId: PROJECT });
  if (
    project.id !== PROJECT ||
    project.autoPull !== false ||
    !Array.isArray(project.scripts) ||
    project.scripts.length !== 0 ||
    !Array.isArray(project.effectiveScripts) ||
    project.effectiveScripts.length !== 0 ||
    object(project.launchCapabilities).enforceNoSetupScripts !== true ||
    typeof project.workspaceRoot !== "string" ||
    !NodePath.isAbsolute(project.workspaceRoot)
  )
    throw new Error("Unsafe project registry configuration");
  const request = await claimCandidate(candidate, {
    stateDir: opts.stateDir,
    pin: opts.pin ?? {
      repository: FORK_RELEASE.upstream.repository,
      tag: FORK_RELEASE.upstream.tag,
      commit: FORK_RELEASE.upstream.sha,
    },
    api: opts.api ?? githubJson,
    now,
    project: { id: PROJECT, scripts: project.scripts, autoPull: false },
  });
  // A timeout/lost response after the durable claim is ambiguous: never retry the launch.
  const launched = await call(opts.transport, "t3_thread_launch", {
    ...request,
    enforceNoSetupScripts: true,
    cleanProviderConstraint: { ...CLEAN_PROVIDER_CONSTRAINT },
    modelSelection: {
      instanceId: "voice-automation",
      model: VOICE_MODEL,
      ...(thinking === "medium" ? { options: { thinking: "medium" } } : {}),
    },
  });
  return reconcileLaunchedThread(launched, {
    ...opts,
    workspaceRoot: project.workspaceRoot,
    branch: request.workspaceStrategy.branch,
    thinking,
  });
}

async function requireSafeProvider(transport: T3ToolTransport): Promise<Thinking> {
  const capabilities = await call(transport, "orchestrator_capabilities", { search: VOICE_MODEL });
  const providers = capabilities.providers;
  if (!Array.isArray(providers)) throw new Error("Provider configuration readback unsupported");
  const matches = providers.filter(
    (p: unknown) =>
      p &&
      typeof p === "object" &&
      !Array.isArray(p) &&
      object(p).providerInstanceId === "voice-automation",
  );
  if (matches.length !== 1 || object(matches[0]).driverKind !== "pi")
    throw new Error("Voice automation requires the actual Pi driver");
  const cleanStart = object(matches[0]).cleanStart;
  if (
    !cleanStart ||
    typeof cleanStart !== "object" ||
    Array.isArray(cleanStart) ||
    object(cleanStart).environmentMode !== "clean" ||
    object(cleanStart).supportsConstraint !== true
  )
    throw new Error("Voice automation requires a supported clean Pi launch constraint");
  const models = object(matches[0]).models;
  const targets = Array.isArray(models)
    ? models.filter(
        (model: unknown) =>
          model &&
          typeof model === "object" &&
          !Array.isArray(model) &&
          object(model).id === VOICE_MODEL,
      )
    : [];
  if (targets.length !== 1) throw new Error("Provider must advertise the exact voice model");
  const options = object(targets[0]).options;
  if (options === undefined) return "provider_default";
  const thinking = Array.isArray(options)
    ? options.filter(
        (option: unknown) =>
          option &&
          typeof option === "object" &&
          !Array.isArray(option) &&
          object(option).id === "thinking",
      )
    : [];
  const values = thinking.length === 1 ? object(thinking[0]).values : undefined;
  if (!Array.isArray(values) || !values.includes("medium"))
    throw new Error("Voice model must advertise medium thinking");
  // Readback is a preflight; the server enforces the constraint at provider spawn.
  return "medium";
}

function isCleanProviderConstraint(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const constraint = object(value);
  return (
    Object.keys(constraint).length === 3 &&
    constraint.instanceId === CLEAN_PROVIDER_CONSTRAINT.instanceId &&
    constraint.driver === CLEAN_PROVIDER_CONSTRAINT.driver &&
    constraint.environmentMode === CLEAN_PROVIDER_CONSTRAINT.environmentMode
  );
}

export async function reconcileLaunchedThread(
  launched: Record<string, unknown>,
  opts: Pick<Options, "stateDir" | "transport"> & {
    workspaceRoot: string;
    branch: string;
    thinking?: Thinking;
  },
) {
  enabled();
  const thinking = opts.thinking ?? "medium";
  const preference = thinking === "provider_default" ? { thinking } : {};
  if (
    launched.enforceNoSetupScripts !== true ||
    !isCleanProviderConstraint(launched.cleanProviderConstraint) ||
    launched.projectId !== PROJECT ||
    typeof launched.threadId !== "string" ||
    !(THREAD_ID.test(launched.threadId) || LAUNCH_THREAD_ID.test(launched.threadId)) ||
    !isVoiceSelection(launched.modelSelection, thinking)
  )
    throw new Error("Launch response identity mismatch; manual reconciliation required");
  const threadId = launched.threadId;
  await recordChildThread(opts.stateDir, threadId);
  const read = await call(opts.transport, "t3_thread_read", {
    threadId,
    limit: 1,
    runLimit: 1,
    maxCharsPerItem: 1,
  });
  const thread = object(read.thread);
  if (
    thread.threadId !== threadId ||
    thread.projectId !== PROJECT ||
    thread.providerInstanceId !== "voice-automation" ||
    thread.model !== VOICE_MODEL
  )
    throw new Error("Recorded thread identity mismatch; manual reconciliation required");
  const configuration = await call(opts.transport, "t3_thread_configure", { threadId });
  if (
    configuration.threadId !== threadId ||
    !isVoiceSelection(configuration.modelSelection, thinking)
  )
    throw new Error("Recorded thread selection mismatch; manual reconciliation required");
  if (thread.status === "preparing")
    return { threadId, binding: "pending_reconciliation" as const, ...preference };
  if (
    thread.branch !== opts.branch ||
    typeof thread.worktreePath !== "string" ||
    !NodePath.isAbsolute(thread.worktreePath)
  )
    throw new Error("Recorded thread worktree mismatch; manual reconciliation required");
  const [root, worktree] = await Promise.all([
    NodeFSP.realpath(opts.workspaceRoot),
    NodeFSP.realpath(thread.worktreePath),
  ]);
  if (root === worktree) throw new Error("Recorded thread is bound to project root");
  try {
    await NodeFSP.lstat(NodePath.join(worktree, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { threadId, binding: "verified" as const, ...preference };
  }
  // This post-launch diagnostic cannot establish pre-start environment isolation.
  throw new Error("Worktree contains .env; manual reconciliation required");
}

export async function auditDeadline(opts: Pick<Options, "stateDir" | "transport" | "now">) {
  enabled();
  const request = await overdueInterruptRequest(opts.stateDir, opts.now ?? new Date());
  if (!request) return { action: "not_due" as const };
  const result = await call(opts.transport, "t3_thread_interrupt", request);
  if (
    result.threadId !== request.threadId ||
    ![
      "interrupt_requested",
      "no_active_run",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "rolled_back",
    ].includes(String(result.status))
  )
    throw new Error("Interrupt response mismatch; manual reconciliation required");
  // Interrupting a turn proves neither a durable stop nor cancellation of queued/nested work.
  return {
    action: "interrupt" as const,
    threadId: request.threadId,
    status: result.status,
    scope: "current_turn_only" as const,
    activeSlotRetained: true,
  };
}

export function acpTransport(env: NodeJS.ProcessEnv = process.env): T3ToolTransport {
  const executable = env.T3_ACP_MCP_NODE;
  if (!executable || !NodePath.isAbsolute(executable))
    throw new Error("Supported ACP transport requires absolute T3_ACP_MCP_NODE");
  const entrypoint = env.T3_ACP_MCP_ENTRYPOINT;
  if (entrypoint && !NodePath.isAbsolute(entrypoint)) throw new Error("Invalid ACP entrypoint");
  return (tool, args, signal) =>
    new Promise((resolve, reject) => {
      NodeChildProcess.execFile(
        executable,
        [...(entrypoint ? [entrypoint] : []), "acp-mcp-call", tool, JSON.stringify(args)],
        {
          env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
          signal,
          timeout: TOOL_TIMEOUT,
          maxBuffer: MAX_RESPONSE,
          encoding: "utf8",
          shell: false,
        },
        (error, stdout) => {
          // execFile errors carry argv/environment-adjacent data; never print the raw error/stderr.
          if (error) return reject(new Error("ACP tool failed; reconcile any claimed launch"));
          try {
            const envelope = object(JSON.parse(stdout) as unknown);
            if (envelope.isError === true) throw new Error("ACP tool returned failure");
            resolve(object(envelope.structuredContent));
          } catch {
            reject(new Error("Invalid ACP structured response; reconcile any claimed launch"));
          }
        },
      );
    });
}

export async function readCandidateFile(path: string, now: Date) {
  const info = await NodeFSP.lstat(path);
  if (!info.isFile() || info.size > 1024) throw new Error("Invalid candidate file or size");
  const file = await NodeFSP.open(path, "r");
  try {
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) throw new Error("Candidate file too large");
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return parseCandidateText(text, now);
  } finally {
    await file.close();
  }
}

function parseCandidateText(text: string, now: Date) {
  const candidate = parseCandidate(JSON.parse(text) as unknown, now);
  // Candidate values are primitives; every syntactic property must occur exactly once.
  if ([...text.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)].length !== Object.keys(candidate).length)
    throw new Error("Duplicate candidate keys");
  return candidate;
}

export async function readCandidateStdin(input: AsyncIterable<Uint8Array>, now: Date) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > 1024) throw new Error("Candidate stdin too large");
    chunks.push(chunk);
  }
  return parseCandidateText(Buffer.concat(chunks).toString("utf8"), now);
}

async function main() {
  enabled();
  const [action, first, second, ...extra] = process.argv.slice(2);
  if (extra.length || !first || (action === "launch" ? !second : action !== "audit" || second))
    throw new Error(
      "Usage: node scripts/voice-upstream-service.ts launch <candidate.json|-> <private-state-dir> | audit <private-state-dir>",
    );
  const transport = acpTransport();
  const now = new Date();
  const result =
    action === "launch"
      ? await launchCandidate(
          first === "-"
            ? await readCandidateStdin(process.stdin, now)
            : await readCandidateFile(first, now),
          { stateDir: second!, transport, now },
        )
      : await auditDeadline({ stateDir: first, transport, now });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      "Voice automation action failed; inspect private state and reconcile before retrying. No launch is retried automatically.",
    );
    process.exitCode = 1;
  });
}
