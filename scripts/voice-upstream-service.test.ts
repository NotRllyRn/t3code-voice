import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, test } from "vitest";
import {
  acpTransport,
  auditDeadline,
  launchCandidate,
  readCandidateFile,
  reconcileLaunchedThread,
  type T3ToolTransport,
} from "./voice-upstream-service.ts";
import { claimCandidate, recordChildThread } from "./voice-upstream-coordinator.ts";
import type { GitHubApi } from "./voice-upstream-poll.ts";

const PROJECT = "mcp:65bad731-4011-462c-96b6-58b9e4fe1cee";
const THREAD = "mcp:00000000-0000-4000-8000-000000000002";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const BRANCH = `auto/upstream-v0.1.10-${NEW.slice(0, 12)}`;
const now = new Date("2026-11-16T12:00:00.000Z");
const pin = { repository: "pingdotgg/t3code", tag: "v0.1.9", commit: OLD };
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
const cleanProviderConstraint = {
  instanceId: "voice-automation",
  driver: "pi",
  environmentMode: "clean",
};
const selection = {
  instanceId: "voice-automation",
  model: "codex-broker/gpt-6.1-sol",
  options: [{ id: "thinking", value: "medium" }],
};
const api: GitHubApi = async (path) => {
  const replies: Record<string, unknown> = {
    "/releases/latest": {
      draft: false,
      prerelease: false,
      tag_name: candidate.tag,
      id: candidate.releaseId,
      published_at: candidate.publishedAt,
    },
    "/git/ref/tags/v0.1.10": { ref: "refs/tags/v0.1.10", object: { type: "commit", sha: NEW } },
    [`/compare/${OLD}...${NEW}`]: { status: "ahead" },
  };
  if (!(path in replies)) throw new Error("Unexpected GitHub fixture path");
  return replies[path];
};

async function fixture(
  run: (f: {
    stateDir: string;
    root: string;
    worktree: string;
    calls: { tool: string; args: Record<string, unknown> }[];
    capabilities: Record<string, unknown>;
    thread: Record<string, unknown>;
    launch: Record<string, unknown>;
    configuration: Record<string, unknown>;
    claim: () => ReturnType<typeof claimCandidate>;
    opts: Parameters<typeof launchCandidate>[1];
    reconcile: () => ReturnType<typeof reconcileLaunchedThread>;
  }) => Promise<void>,
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-service-test-"));
  const stateDir = NodePath.join(dir, "state");
  const root = NodePath.join(dir, "root");
  const worktree = NodePath.join(dir, "worktree");
  await Promise.all([stateDir, root, worktree].map((p) => NodeFSP.mkdir(p, { mode: 0o700 })));
  const previous = process.env.VOICE_AUTOMATION_ENABLED;
  process.env.VOICE_AUTOMATION_ENABLED = "1";
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const project = {
    id: PROJECT,
    workspaceRoot: root,
    scripts: [],
    effectiveScripts: [],
    launchCapabilities: { enforceNoSetupScripts: true },
    autoPull: false,
  };
  const capabilities: Record<string, unknown> = {
    providers: [
      {
        providerInstanceId: "voice-automation",
        driverKind: "pi",
        cleanStart: { environmentMode: "clean", supportsConstraint: true },
      },
    ],
  };
  const thread: Record<string, unknown> = {
    threadId: THREAD,
    projectId: PROJECT,
    providerInstanceId: selection.instanceId,
    model: selection.model,
    branch: BRANCH,
    worktreePath: worktree,
    status: "running",
  };
  const launch = {
    cleanProviderConstraint: structuredClone(cleanProviderConstraint),
    enforceNoSetupScripts: true,
    threadId: THREAD,
    projectId: PROJECT,
    modelSelection: structuredClone(selection),
    runId: null,
    status: "preparing",
  };
  const configuration: Record<string, unknown> = {
    threadId: THREAD,
    modelSelection: structuredClone(selection),
  };
  const transport: T3ToolTransport = async (tool, args, signal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    calls.push({ tool, args });
    switch (tool) {
      case "orchestrator_capabilities":
        return capabilities;
      case "t3_project_read":
        return project;
      case "t3_thread_launch":
        return launch;
      case "t3_thread_read":
        return { thread };
      case "t3_thread_configure":
        return configuration;
      case "t3_thread_interrupt":
        return { threadId: THREAD, runId: null, status: "interrupt_requested" };
    }
  };
  const opts = { stateDir, transport, now, pin, api };
  const claim = () => claimCandidate(candidate, { ...opts, project });
  const reconcile = () =>
    reconcileLaunchedThread(launch, { stateDir, transport, workspaceRoot: root, branch: BRANCH });
  try {
    await run({
      stateDir,
      root,
      worktree,
      calls,
      capabilities,
      thread,
      launch,
      configuration,
      claim,
      opts,
      reconcile,
    });
  } finally {
    if (previous === undefined) delete process.env.VOICE_AUTOMATION_ENABLED;
    else process.env.VOICE_AUTOMATION_ENABLED = previous;
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

test.each([
  undefined,
  null,
  false,
  {},
  { environmentMode: "clean" },
  { supportsConstraint: true },
  { environmentMode: "clean", supportsConstraint: false },
  { environmentMode: "inherit", supportsConstraint: true },
])("unsupported clean capability %j rejects before claim or launch", async (cleanStart) =>
  fixture(async ({ opts, calls, capabilities, stateDir }) => {
    capabilities.providers = [
      { providerInstanceId: "voice-automation", driverKind: "pi", cleanStart },
    ];
    await expect(launchCandidate(candidate, opts)).rejects.toThrow("clean Pi launch constraint");
    expect(calls).toEqual([{ tool: "orchestrator_capabilities", args: {} }]);
    await expect(NodeFSP.stat(NodePath.join(stateDir, "state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }),
);

test("valid clean provider launches with an explicit constraint and retains the absolute deadline", async () =>
  fixture(async ({ opts, calls, stateDir }) => {
    expect(await launchCandidate(candidate, opts)).toEqual({
      threadId: THREAD,
      binding: "verified",
    });
    expect(calls.map(({ tool }) => tool)).toEqual([
      "orchestrator_capabilities",
      "t3_project_read",
      "t3_thread_launch",
      "t3_thread_read",
      "t3_thread_configure",
    ]);
    const request = calls[2]?.args;
    expect(request).toMatchObject({
      projectId: PROJECT,
      enforceNoSetupScripts: true,
      cleanProviderConstraint,
      modelSelection: {
        ...selection,
        options: { thinking: "medium" },
      },
      workspaceStrategy: {
        type: "worktree",
        baseRef: "feature/codex-voice-stable",
        branch: BRANCH,
        startFromOrigin: false,
      },
    });
    expect(request?.message).toContain("absolute deadline 2026-11-16T14:00:00.000Z");
    const state = JSON.parse(await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8"));
    expect(state.active).toMatchObject({
      threadId: THREAD,
      phase: "launched",
      claimedAt: now.toISOString(),
      deadline: "2026-11-16T14:00:00.000Z",
    });
    await expect(launchCandidate(candidate, opts)).rejects.toThrow("Active run");
    expect(calls.filter(({ tool }) => tool === "t3_thread_launch")).toHaveLength(1);
  }));

test("provider mode changed since a successful readback rejects the next attempt before claim", async () =>
  fixture(async ({ opts, capabilities, calls, stateDir }) => {
    const transport: T3ToolTransport = async (tool, args, signal) => {
      const result = await opts.transport(tool, args, signal);
      if (tool === "t3_project_read") throw new Error("Read interrupted before claim");
      return result;
    };
    await expect(launchCandidate(candidate, { ...opts, transport })).rejects.toThrow(
      "Read interrupted",
    );
    capabilities.providers = [
      {
        providerInstanceId: "voice-automation",
        driverKind: "pi",
        cleanStart: { environmentMode: "inherit", supportsConstraint: true },
      },
    ];
    await expect(launchCandidate(candidate, opts)).rejects.toThrow("clean Pi launch constraint");
    expect(calls.filter(({ tool }) => tool === "t3_thread_launch")).toEqual([]);
    await expect(NodeFSP.stat(NodePath.join(stateDir, "state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }));

test.each(["lost response", "server rejected changed provider mode"])(
  "ambiguous launch outcome (%s) keeps the durable claim and never retries",
  async (message) =>
    fixture(async ({ opts, calls, stateDir }) => {
      const transport: T3ToolTransport = async (tool, args, signal) => {
        const result = await opts.transport(tool, args, signal);
        if (tool === "t3_thread_launch") {
          const state = JSON.parse(
            await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8"),
          );
          expect(state.active).toMatchObject({
            phase: "launching",
            threadId: null,
            deadline: "2026-11-16T14:00:00.000Z",
          });
          throw new Error(message);
        }
        return result;
      };
      await expect(launchCandidate(candidate, { ...opts, transport })).rejects.toThrow(message);
      await expect(launchCandidate(candidate, { ...opts, transport })).rejects.toThrow(
        "Active run",
      );
      expect(calls.filter(({ tool }) => tool === "t3_thread_launch")).toHaveLength(1);
    }),
);

test.each([
  undefined,
  null,
  {},
  { ...cleanProviderConstraint, instanceId: "other" },
  { ...cleanProviderConstraint, driver: "codex" },
  { ...cleanProviderConstraint, environmentMode: "inherit" },
  { ...cleanProviderConstraint, extra: true },
])("wrong clean launch acknowledgment %j retains claim without trusting thread", async (ack) =>
  fixture(async ({ opts, launch, stateDir, calls, claim }) => {
    Object.assign(launch, { cleanProviderConstraint: ack });
    await expect(launchCandidate(candidate, opts)).rejects.toThrow("identity mismatch");
    const state = JSON.parse(await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8"));
    expect(state.active).toMatchObject({
      phase: "launching",
      threadId: null,
      deadline: "2026-11-16T14:00:00.000Z",
    });
    expect(calls.map(({ tool }) => tool)).toEqual([
      "orchestrator_capabilities",
      "t3_project_read",
      "t3_thread_launch",
    ]);
    await expect(claim()).rejects.toThrow("Active run");
  }),
);

test.each([
  undefined,
  [],
  [
    {
      providerInstanceId: "voice-automation",
      driverKind: "codex",
      cleanStart: { environmentMode: "clean", supportsConstraint: true },
    },
  ],
  [
    {
      providerInstanceId: "other",
      driverKind: "pi",
      cleanStart: { environmentMode: "clean", supportsConstraint: true },
    },
  ],
  [
    { providerInstanceId: "voice-automation", driverKind: "pi" },
    { providerInstanceId: "voice-automation", driverKind: "pi" },
  ],
])("unsupported or wrong actual provider %j cannot claim", async (providers) =>
  fixture(async ({ opts, capabilities, stateDir, calls }) => {
    capabilities.providers = providers;
    await expect(launchCandidate(candidate, opts)).rejects.toThrow(
      /readback unsupported|actual Pi driver/,
    );
    expect(calls).toEqual([{ tool: "orchestrator_capabilities", args: {} }]);
    await expect(NodeFSP.stat(NodePath.join(stateDir, "state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }),
);

test("disabled gate and invalid external fields are rejected before any tool", async () =>
  fixture(async ({ opts, calls }) => {
    delete process.env.VOICE_AUTOMATION_ENABLED;
    await expect(launchCandidate(candidate, opts)).rejects.toThrow("disabled");
    process.env.VOICE_AUTOMATION_ENABLED = "1";
    for (const changes of [
      { tool: "t3_thread_launch" },
      { projectId: "sandbox" },
      { providerInstanceId: "other" },
    ]) {
      await expect(launchCandidate({ ...candidate, ...changes }, opts)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  }));

test("reconciles an already claimed launch only after exact acknowledgment and persisted selection readback", async () =>
  fixture(async ({ claim, reconcile, calls, stateDir, configuration }) => {
    await claim();
    // Legacy object and canonical array encode the same exact option selection.
    configuration.modelSelection = { ...selection, options: { thinking: "medium" } };
    expect(await reconcile()).toEqual({ threadId: THREAD, binding: "verified" });
    expect(calls).toEqual([
      {
        tool: "t3_thread_read",
        args: { threadId: THREAD, limit: 1, runLimit: 1, maxCharsPerItem: 1 },
      },
      { tool: "t3_thread_configure", args: { threadId: THREAD } },
    ]);
    const state = JSON.parse(await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8"));
    expect(state.active).toMatchObject({ threadId: THREAD, phase: "launched" });
    await expect(claim()).rejects.toThrow("Active run");
  }));

const selectionMismatches = [
  undefined,
  { model: "fixture" },
  { ...selection, instanceId: "other" },
  { ...selection, model: "fixture" },
  { ...selection, options: undefined },
  { ...selection, options: [] },
  { ...selection, options: [{ id: "thinking", value: "high" }] },
  {
    ...selection,
    options: [
      { id: "thinking", value: "medium" },
      { id: "extra", value: true },
    ],
  },
  {
    ...selection,
    options: [
      { id: "thinking", value: "medium" },
      { id: "thinking", value: "medium" },
    ],
  },
  { ...selection, options: { thinking: "medium", extra: true } },
];
test.each(selectionMismatches)(
  "rejects mismatched launch selection %j without recording a guessed thread",
  async (modelSelection) =>
    fixture(async ({ claim, reconcile, launch, stateDir, calls }) => {
      await claim();
      Object.assign(launch, { modelSelection });
      await expect(reconcile()).rejects.toThrow("identity mismatch");
      const state = JSON.parse(
        await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8"),
      );
      expect(state.active.threadId).toBeNull();
      expect(calls).toEqual([]);
      await expect(claim()).rejects.toThrow("Active run");
    }),
);

test.each(selectionMismatches)(
  "persisted selection mismatch %j is not accepted even during preparation",
  async (modelSelection) =>
    fixture(async ({ claim, reconcile, configuration, thread, stateDir }) => {
      await claim();
      Object.assign(configuration, { modelSelection });
      thread.status = "preparing";
      await expect(reconcile()).rejects.toThrow("selection mismatch");
      const state = JSON.parse(
        await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8"),
      );
      expect(state.active.threadId).toBe(THREAD);
      await expect(claim()).rejects.toThrow("Active run");
    }),
);

test.each([{ projectId: "other" }, { threadId: "invalid" }, { enforceNoSetupScripts: undefined }])(
  "rejects launch identity mismatch %j before recording",
  async (changes) =>
    fixture(async ({ claim, reconcile, launch, stateDir }) => {
      await claim();
      Object.assign(launch, changes);
      await expect(reconcile()).rejects.toThrow("identity mismatch");
      const state = JSON.parse(
        await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8"),
      );
      expect(state.active.threadId).toBeNull();
    }),
);

test("preparing remains pending and can reconcile the same thread when ready", async () =>
  fixture(async ({ claim, reconcile, thread, calls, worktree, stateDir }) => {
    await claim();
    Object.assign(thread, { status: "preparing", branch: null, worktreePath: null });
    expect(await reconcile()).toEqual({ threadId: THREAD, binding: "pending_reconciliation" });
    expect(calls.at(-1)).toEqual({ tool: "t3_thread_configure", args: { threadId: THREAD } });
    const recorded = await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8");
    Object.assign(thread, { status: "running", branch: BRANCH, worktreePath: worktree });
    expect(await reconcile()).toEqual({ threadId: THREAD, binding: "verified" });
    expect(await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8")).toBe(recorded);
    expect(calls.map(({ tool }) => tool)).toEqual([
      "t3_thread_read",
      "t3_thread_configure",
      "t3_thread_read",
      "t3_thread_configure",
    ]);
    await expect(claim()).rejects.toThrow("Active run");
  }));

test("transient thread read failure retains the claim and allows reconciliation recovery", async () =>
  fixture(async ({ claim, reconcile, launch, opts, root, stateDir, calls }) => {
    await claim();
    const failingTransport: T3ToolTransport = async (tool) => {
      expect(tool).toBe("t3_thread_read");
      throw new Error("Transient thread read failure");
    };
    await expect(
      reconcileLaunchedThread(launch, {
        ...opts,
        transport: failingTransport,
        workspaceRoot: root,
        branch: BRANCH,
      }),
    ).rejects.toThrow("Transient thread read failure");
    const recorded = await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8");
    expect(JSON.parse(recorded).active).toMatchObject({ threadId: THREAD, phase: "launched" });
    await expect(claim()).rejects.toThrow("Active run");
    expect(await reconcile()).toEqual({ threadId: THREAD, binding: "verified" });
    expect(await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8")).toBe(recorded);
    expect(calls.map(({ tool }) => tool)).toEqual(["t3_thread_read", "t3_thread_configure"]);
  }));

test.each([
  { projectId: "other" },
  { threadId: "mcp:00000000-0000-4000-8000-000000000003" },
  { providerInstanceId: "other" },
  { model: "fixture" },
  { branch: "main" },
  { worktreePath: null },
])("read identity/binding mismatch %j retains thread for reconciliation", async (changes) =>
  fixture(async ({ claim, reconcile, thread, stateDir }) => {
    await claim();
    Object.assign(thread, changes);
    await expect(reconcile()).rejects.toThrow("mismatch");
    const state = JSON.parse(await NodeFSP.readFile(NodePath.join(stateDir, "state.json"), "utf8"));
    expect(state.active.threadId).toBe(THREAD);
  }),
);

test("configuration readback must identify the recorded thread", async () =>
  fixture(async ({ claim, reconcile, configuration }) => {
    await claim();
    configuration.threadId = "other";
    await expect(reconcile()).rejects.toThrow("selection mismatch");
  }));

test("rejects root binding even when the returned branch looks correct", async () =>
  fixture(async ({ claim, reconcile, root, thread }) => {
    await claim();
    thread.worktreePath = root;
    await expect(reconcile()).rejects.toThrow("project root");
  }));

test("worktree .env is rejected after recording its identity for operator interruption", async () =>
  fixture(async ({ claim, reconcile, worktree }) => {
    await claim();
    await NodeFSP.symlink("missing-secret", NodePath.join(worktree, ".env"));
    await expect(reconcile()).rejects.toThrow("contains .env");
  }));

test("deadline audit sends only supported interrupt arguments, reports semantics and retains slot", async () =>
  fixture(async ({ opts, calls, stateDir, claim }) => {
    expect(await auditDeadline(opts)).toEqual({ action: "not_due" });
    expect(calls).toEqual([]);
    await claim();
    await expect(auditDeadline({ ...opts, now: new Date("2026-11-16T14:00:00Z") })).rejects.toThrow(
      "manual reconciliation",
    );
    expect(calls).toEqual([]);
    await recordChildThread(stateDir, THREAD);
    expect(await auditDeadline({ ...opts, now: new Date("2026-11-16T13:59:59Z") })).toEqual({
      action: "not_due",
    });
    const overdue = { ...opts, now: new Date("2026-11-16T14:00:00Z") };
    expect(await auditDeadline(overdue)).toEqual({
      action: "interrupt",
      threadId: THREAD,
      status: "interrupt_requested",
      scope: "current_turn_only",
      activeSlotRetained: true,
    });
    expect(calls.at(-1)).toEqual({
      tool: "t3_thread_interrupt",
      args: { threadId: THREAD, reason: "Voice upgrade two-hour deadline reached" },
    });
    const transport: T3ToolTransport = async () => ({
      threadId: "other",
      status: "interrupt_requested",
    });
    await expect(auditDeadline({ ...overdue, transport })).rejects.toThrow(
      "Interrupt response mismatch",
    );
    const idleTransport: T3ToolTransport = async () => ({
      threadId: THREAD,
      runId: null,
      status: "no_active_run",
    });
    expect(await auditDeadline({ ...overdue, transport: idleTransport })).toMatchObject({
      status: "no_active_run",
      activeSlotRetained: true,
    });
    await expect(claim()).rejects.toThrow("Active run");
    delete process.env.VOICE_AUTOMATION_ENABLED;
    const count = calls.length;
    await expect(auditDeadline(overdue)).rejects.toThrow("disabled");
    expect(calls).toHaveLength(count);
  }));

test("bounded candidate JSON rejects duplicates, extra keys, shell payload and oversized input; ACP requires supported env", async () =>
  fixture(async ({ stateDir }) => {
    const path = NodePath.join(stateDir, "candidate.json");
    await NodeFSP.writeFile(path, JSON.stringify(candidate));
    expect(await readCandidateFile(path, now)).toEqual(candidate);
    for (const text of [
      `{"schema":1,${JSON.stringify(candidate).slice(1)}`,
      JSON.stringify({ ...candidate, env: { KEY: "secret" } }),
      JSON.stringify({ ...candidate, sha: "$(touch /tmp/never-run)" }),
      " ".repeat(1025),
    ]) {
      await NodeFSP.writeFile(path, text);
      await expect(readCandidateFile(path, now)).rejects.toThrow();
    }
    expect(() => acpTransport({})).toThrow("T3_ACP_MCP_NODE");
    expect(() => acpTransport({ T3_ACP_MCP_NODE: "untrusted-command" })).toThrow();
    expect(() =>
      acpTransport({ T3_ACP_MCP_NODE: "/trusted/runtime", T3_ACP_MCP_ENTRYPOINT: "relative" }),
    ).toThrow();
  }));
