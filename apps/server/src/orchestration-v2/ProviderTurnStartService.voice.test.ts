import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextHandoffId,
  MessageId,
  NodeId,
  OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import { ThreadWorktreeRestore } from "../workspace/restoreMissingWorktree.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import { layerNoTaskFolders } from "./ProviderTurnStartService.testkit.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import { seedCancelledVoiceHistory, seedLateVoiceHistory } from "./VoiceConversation.testkit.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);
const managedWorktreesDir = "/tmp/provider-turn-start-worktrees";

const layerWorktreeLocation = (worktreesDir = managedWorktreesDir) =>
  Layer.mergeAll(
    Path.layer,
    Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as ServerConfig.ServerConfig["Service"]),
    ServerSettings.layerTest(),
  );

function makeVoiceTurnStartHarness(input: {
  readonly text: string;
  readonly voiceHistory?: "native" | "unsupported" | "inline";
  readonly resumeFailure?: ProviderAdapter.ProviderAdapterError;
  readonly openFailure?: unknown;
  readonly worktreesDir?: string;
  readonly worktreePath?: string;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly failReadsAfterRunning?: boolean;
  readonly recreatedBeforeDispatch?: boolean;
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
}) {
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-voice-turn-start");
  const runId = RunId.make("run-voice-turn-start");
  const rootNodeId = NodeId.make("root-voice-turn-start");
  const attemptId = RunAttemptId.make("attempt-voice-turn-start");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-voice-turn-start");
  const messageId = MessageId.make("message-voice-turn-start");

  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: { instanceId: newInstanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef:
      input.resumeFailure === undefined
        ? null
        : {
            driver: ProviderDriverKind.make("codex"),
            nativeId: "existing-native-conversation",
            strength: "strong",
          },
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      projectId: ProjectId.make("project-voice-turn-start"),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: input.worktreePath === undefined ? null : "feature/restore",
      worktreePath: input.worktreePath ?? null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [run],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [providerThread],
    messages: [message],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/voice-turn-start",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };

  const providerSession = {
    id: providerSessionId,
    driver: providerThread.driver,
    providerInstanceId: newInstanceId,
    status: "ready",
    cwd: "/tmp/voice-turn-start",
    model: null,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const startTurn = vi.fn((_turn: ProviderAdapter.ProviderAdapterV2TurnInput) => Effect.void);
  const sideChatThread = {
    ...providerThread,
    nativeThreadRef: {
      driver: providerThread.driver,
      nativeId: "side-chat-native",
      strength: "strong" as const,
    },
  };
  const injectHistory = vi.fn((_history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
    Effect.succeed(input.voiceHistory === "native"),
  );
  const voiceSession = {
    ...(input.voiceHistory === "native" || input.voiceHistory === "unsupported"
      ? { injectHistory }
      : {}),
    driver: providerThread.driver,
    providerSession,
    ensureThread: () => Effect.succeed(sideChatThread),
    resumeThread: () =>
      input.resumeFailure === undefined
        ? Effect.succeed(sideChatThread)
        : Effect.fail(input.resumeFailure),
    forkThread: () => Effect.succeed(sideChatThread),
    startTurn,
    resumeTurn: (turnInput: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
      startTurn(ProviderAdapter.resumeTurnInput(turnInput)),
  };
  const open = vi.fn(() =>
    input.voiceHistory !== undefined
      ? Effect.succeed(voiceSession as never)
      : "openFailure" in input
        ? Effect.fail(
            new ProviderSessionManager.ProviderSessionOpenError({
              instanceId: newInstanceId,
              providerSessionId,
              cause: input.openFailure,
            }),
          )
        : Effect.succeed({
            driver: providerThread.driver,
            providerSession,
            ensureThread: () => Effect.succeed(providerThread),
            resumeThread: () => Effect.succeed(projection.providerThreads[0]),
          } as never),
  );
  const startRootRun = vi.fn<
    (
      runInput: RunExecutionService.RunExecutionServiceV2StartRootRunInput,
    ) => Effect.Effect<void, RunExecutionService.RunExecutionServiceV2Error>
  >((runInput) =>
    input.voiceHistory !== undefined
      ? (runInput.resume
          ? runInput.session.resumeTurn!({
              ...runInput,
              messageId: runInput.message.messageId,
            } as never)
          : runInput.session.startTurn(runInput as never)
        ).pipe(Effect.orDie)
      : Effect.void,
  );
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true &&
    projection.runs.find((candidate) => candidate.id === runId)?.status === "running"
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
  const writeIfRunCurrent = vi.fn<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>(
    ({ events: incoming, activeAttemptId, expectedStatus }) =>
      Effect.sync(() => {
        const current = projection.runs.find((candidate) => candidate.id === runId);
        const committed =
          current !== undefined &&
          current.activeAttemptId === activeAttemptId &&
          current.status === expectedStatus;
        if (committed) {
          for (const event of incoming) {
            expect(isDomainEvent(event)).toBe(true);
            projection = ProjectionStore.applyToProjection(projection, event);
          }
        }
        return { committed, storedEvents: [] };
      }),
  );
  const createWorktree = vi.fn<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>(() =>
    Effect.succeed({} as never),
  );
  const getThreadRecords = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"]>(
    (_id, _fields, filter) =>
      Effect.succeed({
        ...projection,
        turnItems: projection.turnItems.filter(
          (item) =>
            (filter?.turnItemRunIds === undefined || filter.turnItemRunIds.includes(item.runId)) &&
            (filter?.turnItemTypes === undefined || filter.turnItemTypes.includes(item.type)) &&
            (filter?.voiceHistory === undefined ||
              (item.voice !== undefined &&
                (filter.voiceHistory.throughOrdinal === undefined ||
                  item.ordinal <= filter.voiceHistory.throughOrdinal) &&
                (filter.voiceHistory.afterOrdinal === undefined ||
                  item.ordinal > filter.voiceHistory.afterOrdinal))),
        ),
      }),
  );
  const getRuntimeRecoveryProjection = vi.fn<
    ProjectionStore.ProjectionStoreV2Shape["getRuntimeRecoveryProjection"]
  >(() =>
    Effect.as(failReadIfRunning, {
      ...projection,
      hasConversation: projection.messages.some(
        (m) =>
          m.role === "user" &&
          (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
      ),
    }),
  );
  const recreatedBeforeDispatch = { pending: input.recreatedBeforeDispatch === true };
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        input.voiceHistory !== undefined
          ? ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer))
          : Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
              prepareProviderHandoff: () => Effect.die("unexpected handoff"),
            }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent,
          write: ({ events: incoming }) =>
            Effect.sync(() => {
              for (const event of incoming) {
                projection = ProjectionStore.applyToProjection(projection, event);
              }
              return [];
            }),
        }),
        IdAllocator.layer,
        Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
          allocate: () => Effect.succeed(99),
        }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: input.runSetup ?? (() => Effect.succeed({ status: "no-script" })),
        }),
        Layer.mock(ThreadWorktreeRestore)({
          takeRecreated: () =>
            Effect.sync(() => {
              if (!recreatedBeforeDispatch.pending || input.worktreePath === undefined) return;
              recreatedBeforeDispatch.pending = false;
              return {
                project: { workspaceRoot: "/tmp/voice-turn-start-project" } as never,
                worktreePath: input.worktreePath,
              };
            }),
        }),
        layerWorktreeLocation(input.worktreesDir),
        layerNoTaskFolders,
        input.fileSystem === undefined
          ? FileSystem.layerNoop({ exists: () => Effect.succeed(true) })
          : Layer.succeed(FileSystem.FileSystem, input.fileSystem),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees: () => Effect.void,
          listLocalBranchNames: () => Effect.succeed(["feature/restore"]),
          createWorktree,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({ workspaceRoot: "/tmp/voice-turn-start-project" } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getForkSourceRunIds: () => Effect.succeed([]),
          getThreadRecords,
          getTurnStartContext: () =>
            Effect.succeed({
              ...projection,
              hasConversation: true,
            }),
          getRuntimeRecoveryProjection,
          getRun: (_threadId, id) =>
            Effect.as(
              failReadIfRunning,
              projection.runs.find((candidate) => candidate.id === id),
            ),
          getTurnStartHistory: () =>
            Effect.succeed(input.voiceHistory !== undefined ? projection.turnItems : []),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open,
          get: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun,
          forkBaseline: () => Effect.succeed(Effect.void),
        }),
        Layer.succeed(ProviderUsageAnalytics.ProviderTurnAnalytics, {
          runStarted: () => Effect.void,
          turnCompleted: () => Effect.void,
          runSettled: () => Effect.void,
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: ({ thread }) =>
            Effect.succeed({
              cwd: thread.worktreePath ?? "/tmp/voice-turn-start",
              runtimeMode: thread.runtimeMode,
            } as never),
        }),
      ),
    ),
  );
  return {
    newInstanceId,
    getRuntimeRecoveryProjection,
    createWorktree,
    open,
    startRootRun,
    startTurn,
    injectHistory,
    setProjection: (next: OrchestrationV2ThreadProjection) => {
      projection = next;
    },
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect.each([false, true])(
  "restored setup retains launch script guard=%s",
  (enforceNoSetupScripts) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreesDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-sent-setup-" });
      const worktreePath = path.join(worktreesDir, "project", "restore");
      yield* fileSystem.makeDirectory(path.join(worktreePath, ".git"), { recursive: true });
      const runSetup = vi.fn(() => Effect.succeed({ status: "no-script" as const }));
      const harness = makeVoiceTurnStartHarness({
        text: "Continue",
        worktreesDir,
        worktreePath,
        fileSystem,
        failReadsAfterRunning: true,
        recreatedBeforeDispatch: true,
        runSetup,
      });
      const projection = harness.projection();
      harness.setProjection({
        ...projection,
        runs: projection.runs.map((run) => ({
          ...run,
          workspacePreparation: { type: "root", enforceNoSetupScripts },
        })),
      });
      yield* harness.start;
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(runSetup).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath, enforceNoSetupScripts }),
      );
      expect(harness.open).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

effectIt.effect.each(["current", "historical", "claim"] as const)(
  "retires clean work before provider startup (%s)",
  (source) =>
    Effect.gen(function* () {
      const runSetup = vi.fn(() => Effect.succeed({ status: "no-script" as const }));
      const harness = makeVoiceTurnStartHarness({
        text: "Continue",
        worktreePath: "/tmp/retired-worktree",
        recreatedBeforeDispatch: true,
        runSetup,
        openFailure: new Error("provider session rejected"),
      });
      const constraint = {
        instanceId: harness.newInstanceId,
        driver: "pi" as const,
        environmentMode: "clean" as const,
      };
      const projection = harness.projection();
      harness.setProjection({
        ...projection,
        runs:
          source === "historical"
            ? [
                {
                  ...projection.runs[0]!,
                  id: RunId.make("old-clean-run"),
                  ordinal: 0,
                  status: "completed",
                  workspacePreparation: { type: "root", cleanProviderConstraint: constraint },
                },
                ...projection.runs.map((run) => ({ ...run, ordinal: run.ordinal + 1 })),
              ]
            : projection.runs.map((run) => ({
                ...run,
                workspacePreparation: { type: "root", cleanProviderConstraint: constraint },
              })),
      });
      if (source === "claim") {
        harness.setProjection(projection);
        harness.getRuntimeRecoveryProjection.mockImplementation(() =>
          Effect.succeed({ ...projection, retiredCleanAutomation: true }),
        );
      }
      yield* harness.startWithRetry;
      expect(runSetup).not.toHaveBeenCalled();
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    }),
);

for (const mode of ["native", "unsupported", "inline"] as const) {
  effectIt.effect(`voice history reaches the actual next provider turn via ${mode}`, () =>
    Effect.gen(function* () {
      const harness = makeVoiceTurnStartHarness({
        text: "CURRENT_EXECUTION_INPUT",
        voiceHistory: mode,
      });
      const projection = harness.projection();
      const run = projection.runs.at(-1)!;
      const base = {
        threadId: projection.thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed" as const,
        title: null,
        startedAt: run.requestedAt,
        completedAt: run.requestedAt,
        updatedAt: run.requestedAt,
      };
      const voice = {
        sessionId: "voice",
        itemId: "user",
        sequence: 1,
        textKind: "final_user_transcript" as const,
        delivery: "unknown" as const,
      };
      harness.setProjection({
        ...projection,
        runs: projection.runs.map((source) => ({ ...source, voiceHistoryCutoffOrdinal: 2 })),
        turnItems: [
          {
            ...base,
            id: TurnItemId.make("voice-user"),
            ordinal: 1,
            type: "user_message",
            messageId: MessageId.make("prior-voice-user"),
            text: "PRIOR_VOICE_QUESTION",
            inputIntent: "conversation_only",
            createdBy: "user",
            creationSource: "web",
            attachments: [],
            voice,
          },
          {
            ...base,
            id: TurnItemId.make("voice-assistant"),
            ordinal: 2,
            type: "assistant_message",
            messageId: MessageId.make("prior-voice-assistant"),
            text: "GENERATED_VOICE_REPLY",
            streaming: false,
            voice: {
              ...voice,
              itemId: "assistant",
              sequence: 2,
              responseId: "response",
              textKind: "generated_voice_reply",
              delivery: "interrupted",
            },
          },
          {
            ...base,
            id: TurnItemId.make("active-input"),
            ordinal: 2,
            type: "user_message",
            messageId: run.userMessageId,
            text: "CURRENT_EXECUTION_INPUT",
            inputIntent: "turn_start",
            createdBy: "user",
            creationSource: "web",
            attachments: [],
            voice,
          },
          {
            ...base,
            id: TurnItemId.make("too-late"),
            ordinal: 3,
            type: "assistant_message",
            messageId: MessageId.make("later-voice"),
            text: "MUST_WAIT_UNTIL_NEXT_TURN",
            streaming: false,
            voice: {
              ...voice,
              itemId: "later",
              sequence: 3,
              responseId: "later",
              textKind: "generated_voice_reply",
              delivery: "pending",
            },
          },
        ],
      });
      yield* harness.start;
      expect(harness.startTurn).toHaveBeenCalledOnce();
      const prompt = harness.startTurn.mock.calls[0]![0].message.text;
      const injected = harness.injectHistory.mock.calls[0]?.[0];
      if (mode === "native") {
        expect(injected?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(injected?.messages.map((message) => message.itemId)).toEqual([
          "voice-user",
          "voice-assistant",
        ]);
        expect(prompt).toBe("CURRENT_EXECUTION_INPUT");
        expect(injected?.messages[1]?.text).toContain("not verified tool execution");
        expect(injected?.messages[1]?.text).toContain("playback interrupted");
      } else {
        expect(prompt).toContain("PRIOR_VOICE_QUESTION");
        expect(prompt).toContain("GENERATED_VOICE_REPLY");
        expect(prompt).toContain("not verified tool execution");
        expect(prompt.match(/CURRENT_EXECUTION_INPUT/g)).toHaveLength(1);
      }
      const serialized = JSON.stringify({
        input: prompt,
        items:
          mode === "native" && injected
            ? historyResponseItems(injected.messages, injected.context)
            : [],
      });
      for (const text of [
        "CURRENT_EXECUTION_INPUT",
        "PRIOR_VOICE_QUESTION",
        "GENERATED_VOICE_REPLY",
      ])
        expect(serialized.split(text)).toHaveLength(2);
      expect(serialized).not.toContain("MUST_WAIT_UNTIL_NEXT_TURN");
      expect(prompt).not.toContain("MUST_WAIT_UNTIL_NEXT_TURN");
      expect(harness.projection().contextHandoffs[0]?.delivery?.status).toBe(
        mode === "native" ? "injected" : "inline",
      );
      // A duplicate start event while this run is running cannot mutate its live provider turn.
      yield* harness.start;
      expect(harness.startTurn).toHaveBeenCalledOnce();
      const next = makeVoiceTurnStartHarness({
        text: "SECOND_EXECUTION_INPUT",
        voiceHistory: mode,
      });
      const previousRunId = RunId.make("previous-voice-execution");
      const after = harness.projection();
      const nextProjection = next.projection();
      next.setProjection({
        ...nextProjection,
        providerThreads: after.providerThreads,
        turnItems: after.turnItems.filter((item) => item.voice !== undefined),
        runs: [
          { ...after.runs.at(-1)!, id: previousRunId, status: "completed" },
          { ...nextProjection.runs.at(-1)!, ordinal: 3, voiceHistoryCutoffOrdinal: 2 },
        ],
        contextHandoffs: after.contextHandoffs.map((handoff) => ({
          ...handoff,
          id: ContextHandoffId.make("context-handoff:voice:previous-run"),
          targetRunId: previousRunId,
        })),
      });
      yield* next.start;
      expect(next.injectHistory).not.toHaveBeenCalled();
      expect(next.startTurn.mock.calls[0]?.[0].message.text).toBe("SECOND_EXECUTION_INPUT");
      const later = makeVoiceTurnStartHarness({
        text: "THIRD_EXECUTION_INPUT",
        voiceHistory: mode,
      });
      const laterProjection = later.projection();
      later.setProjection({
        ...laterProjection,
        providerThreads: after.providerThreads,
        turnItems: after.turnItems,
        runs: [
          { ...after.runs.at(-1)!, id: previousRunId, status: "completed" },
          { ...laterProjection.runs.at(-1)!, ordinal: 4, voiceHistoryCutoffOrdinal: 3 },
        ],
        contextHandoffs: next.projection().contextHandoffs,
      });
      yield* later.start;
      const laterPrompt = later.startTurn.mock.calls[0]![0].message.text;
      const laterHistory = later.injectHistory.mock.calls[0]?.[0];
      const deliveredLater = JSON.stringify({
        input: laterPrompt,
        items:
          mode === "native" && laterHistory
            ? historyResponseItems(laterHistory.messages, laterHistory.context)
            : [],
      });
      expect(deliveredLater.split("MUST_WAIT_UNTIL_NEXT_TURN")).toHaveLength(2);
      expect(deliveredLater).not.toContain("GENERATED_VOICE_REPLY");
      expect(deliveredLater).not.toContain("PRIOR_VOICE_QUESTION");
      yield* later.start;
      expect(later.startTurn).toHaveBeenCalledOnce();
      const cleared = makeVoiceTurnStartHarness({ text: "FRESH_INPUT", voiceHistory: mode });
      const freshProjection = cleared.projection();
      cleared.setProjection({
        ...freshProjection,
        turnItems: after.turnItems,
        runs: [
          { ...after.runs.at(-1)!, id: previousRunId, status: "completed" },
          {
            ...freshProjection.runs.at(-1)!,
            ordinal: 2,
            freshContext: true,
            voiceHistoryCutoffOrdinal: 2,
          },
        ],
        contextHandoffs: after.contextHandoffs.map((handoff) => ({
          ...handoff,
          id: ContextHandoffId.make("context-handoff:voice:previous-run"),
          targetRunId: previousRunId,
          delivery:
            handoff.delivery == null
              ? handoff.delivery
              : {
                  ...handoff.delivery,
                  nativeThreadId: "obsolete-native-thread",
                },
        })),
      });
      yield* cleared.start;
      expect(cleared.injectHistory).not.toHaveBeenCalled();
      expect(cleared.startTurn.mock.calls[0]?.[0].message.text).toBe("FRESH_INPUT");
      const postClear = makeVoiceTurnStartHarness({
        text: "AFTER_CLEAR_INPUT",
        voiceHistory: mode,
      });
      const postClearProjection = postClear.projection();
      postClear.setProjection({
        ...postClearProjection,
        turnItems: after.turnItems,
        runs: [
          ...cleared
            .projection()
            .runs.map((source) =>
              source.freshContext === true
                ? { ...source, id: RunId.make("clear-run"), status: "completed" as const }
                : source,
            ),
          { ...postClearProjection.runs.at(-1)!, ordinal: 3, voiceHistoryCutoffOrdinal: 3 },
        ],
        contextHandoffs: cleared.projection().contextHandoffs,
      });
      yield* postClear.start;
      const newPrompt = postClear.startTurn.mock.calls[0]![0].message.text;
      const newContext = postClear.injectHistory.mock.calls[0]?.[0];
      if (mode === "native") {
        expect(newContext?.messages.map((message) => message.itemId)).toEqual(["too-late"]);
      } else {
        expect(newPrompt).toContain("MUST_WAIT_UNTIL_NEXT_TURN");
        expect(newPrompt).not.toContain("PRIOR_VOICE_QUESTION");
        expect(newPrompt).not.toContain("GENERATED_VOICE_REPLY");
      }
    }),
  );
}

for (const mode of ["native", "inline"] as const) {
  effectIt.effect(
    `persisted mixed voice chronology freezes queued provider context via ${mode}`,
    () =>
      Effect.gen(function* () {
        const harness = makeVoiceTurnStartHarness({
          text: "CURRENT_EXECUTION_INPUT",
          voiceHistory: mode,
        });
        const projection = harness.projection();
        const { normal, queued, after } = yield* seedLateVoiceHistory(projection.thread.id);
        const prior = after.turnItems.find((item) => item.voice?.itemId === "input-one")!;
        const later = after.turnItems.find((item) => item.voice?.itemId === "later")!;
        const normalItem = after.turnItems.find((item) => item.runId === normal.run.id)!;
        harness.setProjection({
          ...projection,
          turnItems: after.turnItems,
          runs: projection.runs.map((run) => ({
            ...run,
            voiceHistoryCutoffOrdinal: queued.run.voiceHistoryCutoffOrdinal,
          })),
        });
        yield* harness.start;
        expect(harness.startTurn).toHaveBeenCalledOnce();
        const prompt = harness.startTurn.mock.calls[0]![0].message.text;
        const history = harness.injectHistory.mock.calls
          .flatMap(([context]) => context.messages.map((message) => message.text))
          .join("\n");
        expect(mode === "native" ? history : prompt).toContain("VOICE_BEFORE_DISPATCH");
        expect(`${history}\n${prompt}`).not.toContain("VOICE_AFTER_DISPATCH");
        expect(`${history}\n${prompt}`.match(/CURRENT_EXECUTION_INPUT/g)).toHaveLength(1);
        expect(prior.ordinal).toBeGreaterThan(normalItem.ordinal);
        expect(later.ordinal).toBeGreaterThan(queued.run.voiceHistoryCutoffOrdinal!);
        expect(queued.run.voiceHistoryCutoffOrdinal).toBe(prior.ordinal);
      }),
  );

  effectIt.effect(
    `cancelled undelivered voice remains conversation without restarting its task via ${mode}`,
    () =>
      Effect.gen(function* () {
        const harness = makeVoiceTurnStartHarness({
          text: "CURRENT_EXECUTION_INPUT",
          voiceHistory: mode,
        });
        const projection = harness.projection();
        const { queuedVoice, next, after } = yield* seedCancelledVoiceHistory(projection.thread.id);
        const cancelled = after.runs.find((run) => run.id === queuedVoice.run.id)!;
        expect(cancelled.status).toBe("cancelled");
        expect(after.messages.find((message) => message.id === cancelled.userMessageId)?.text).toBe(
          "CANCELLED_EXECUTION_CONVERSATION",
        );
        harness.setProjection({
          ...projection,
          turnItems: after.turnItems,
          runs: [
            cancelled,
            {
              ...projection.runs.at(-1)!,
              ordinal: next.run.ordinal,
              voiceHistoryCutoffOrdinal: next.run.voiceHistoryCutoffOrdinal,
            },
          ],
        });
        yield* harness.start;
        expect(harness.startTurn).toHaveBeenCalledOnce();
        const prompt = harness.startTurn.mock.calls[0]![0].message.text;
        const history = harness.injectHistory.mock.calls
          .flatMap(([context]) => context.messages.map((message) => message.text))
          .join("\n");
        expect(mode === "native" ? history : prompt).toContain("CANCELLED_EXECUTION_CONVERSATION");
        if (mode === "native") {
          expect(harness.injectHistory.mock.calls[0]![0].messages[0]?.runStatus).toBe("cancelled");
        } else {
          expect(prompt).toContain("run-status=cancelled");
        }
        expect(`${history}\n${prompt}`.match(/CURRENT_EXECUTION_INPUT/g)).toHaveLength(1);
        expect(harness.projection().runs.find((run) => run.id === cancelled.id)?.status).toBe(
          "cancelled",
        );
      }),
  );

  for (const boundary of ["cutoff", "clear", "fresh", "rollback"] as const) {
    effectIt.effect(`native recovery respects voice ${boundary} boundary via ${mode}`, () =>
      Effect.gen(function* () {
        const harness = makeVoiceTurnStartHarness({
          text: "CURRENT_EXECUTION_INPUT",
          voiceHistory: mode,
          resumeFailure: new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: ProviderDriverKind.make("codex"),
            providerSessionId: ProviderSessionId.make("lost-voice-session"),
            cause: "native thread lost",
          }),
        });
        const projection = harness.projection();
        const run = projection.runs.at(-1)!;
        const items = [1, 3].map((ordinal) => ({
          id: TurnItemId.make(`recovery-voice-${ordinal}`),
          ordinal,
          threadId: projection.thread.id,
          runId: boundary === "rollback" && ordinal === 1 ? RunId.make("rolled-back-voice") : null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          status: "completed" as const,
          title: null,
          startedAt: run.requestedAt,
          completedAt: run.requestedAt,
          updatedAt: run.requestedAt,
          type: "user_message" as const,
          messageId: MessageId.make(`recovery-voice-${ordinal}`),
          text: ordinal === 1 ? "VOICE_BEFORE_BOUNDARY" : "VOICE_AFTER_BOUNDARY",
          inputIntent: "conversation_only" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
          attachments: [],
          voice: {
            sessionId: "recovery",
            itemId: `item-${ordinal}`,
            sequence: ordinal,
            textKind: "final_user_transcript" as const,
            delivery: "unknown" as const,
          },
        }));
        harness.setProjection({
          ...projection,
          runs: [
            ...(boundary === "rollback"
              ? [
                  {
                    ...run,
                    id: RunId.make("rolled-back-voice"),
                    ordinal: 1,
                    status: "rolled_back" as const,
                  },
                ]
              : []),
            ...(boundary === "clear"
              ? [
                  {
                    ...run,
                    id: RunId.make("cleared-run"),
                    ordinal: 1,
                    status: "completed" as const,
                    freshContext: true,
                    voiceHistoryCutoffOrdinal: 1,
                  },
                ]
              : []),
            {
              ...run,
              ordinal: 2,
              voiceHistoryCutoffOrdinal: boundary === "cutoff" ? 2 : 3,
              ...(boundary === "fresh" ? { freshContext: true } : {}),
            },
          ],
          turnItems: [
            ...items,
            {
              ...items[0]!,
              id: TurnItemId.make("current-voice"),
              ordinal: 2,
              voice: { ...items[0]!.voice, itemId: "current-input", sequence: 2 },
              messageId: run.userMessageId,
              runId: run.id,
              text: "CURRENT_EXECUTION_INPUT",
              inputIntent: "turn_start" as const,
            },
          ].toSorted((a, b) => a.ordinal - b.ordinal),
        });
        yield* harness.start;
        expect(harness.startTurn).toHaveBeenCalledOnce();
        const prompt = harness.startTurn.mock.calls[0]![0].message.text;
        const messages = harness.injectHistory.mock.calls.flatMap(([context]) => context.messages);
        const history = messages.map((message) => message.text).join("\n");
        const delivered = `${history}\n${prompt}`;
        expect(delivered.match(/CURRENT_EXECUTION_INPUT/g)).toHaveLength(1);
        expect(messages.some((message) => message.itemId === "current-voice")).toBe(false);
        if (boundary === "cutoff") {
          expect(delivered).toContain("VOICE_BEFORE_BOUNDARY");
          expect(delivered).not.toContain("VOICE_AFTER_BOUNDARY");
        } else {
          expect(delivered).not.toContain("VOICE_BEFORE_BOUNDARY");
          if (boundary === "clear" || boundary === "rollback")
            expect(delivered).toContain("VOICE_AFTER_BOUNDARY");
          else expect(delivered).not.toContain("VOICE_AFTER_BOUNDARY");
        }
        if (boundary !== "fresh")
          expect(
            harness
              .projection()
              .contextHandoffs.some((handoff) => handoff.strategy === "full_thread_summary"),
          ).toBe(true);
      }),
    );
  }
}

for (const retry of [false, true]) {
  effectIt.effect(
    `supplemental voice at full native context neither rejects replies nor replaces the session (retry=${retry})`,
    () =>
      Effect.gen(function* () {
        const harness = makeVoiceTurnStartHarness({
          text: "Continue with blue",
          voiceHistory: "inline",
        });
        const projection = harness.projection();
        const run = projection.runs.at(-1)!;
        const providerThread = projection.providerThreads[0]!;
        const item: OrchestrationV2ThreadProjection["turnItems"][number] = {
          id: TurnItemId.make("voice-budget-user"),
          threadId: projection.thread.id,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: run.requestedAt,
          completedAt: run.requestedAt,
          updatedAt: run.requestedAt,
          type: "user_message",
          messageId: MessageId.make("voice-budget-user"),
          text: "Earlier spoken context",
          inputIntent: "conversation_only",
          createdBy: "user",
          creationSource: "web",
          attachments: [],
          voice: {
            sessionId: "voice",
            itemId: "budget",
            sequence: 1,
            textKind: "final_user_transcript",
            delivery: "unknown",
          },
        };
        harness.setProjection({
          ...projection,
          runs: projection.runs.map((source) => ({ ...source, voiceHistoryCutoffOrdinal: 1 })),
          providerThreads: projection.providerThreads.map((source) => ({
            ...source,
            nativeThreadRef: {
              driver: source.driver,
              nativeId: "side-chat-native",
              strength: "strong",
            },
            contextUsage: { usedTokens: 128000, maxTokens: 128000 },
          })),
          turnItems: [item],
          contextHandoffs: retry
            ? [
                {
                  id: ContextHandoffId.make(`context-handoff:voice:${run.id}`),
                  threadId: run.threadId,
                  targetRunId: run.id,
                  fromProviderThreadIds: [],
                  toProviderThreadId: providerThread.id,
                  coveredRunOrdinals: { from: run.ordinal, to: run.ordinal },
                  strategy: "manual_context",
                  status: "ready",
                  summaryMessageId: null,
                  summaryText: "",
                  createdByProviderInstanceId: null,
                  createdAt: run.requestedAt,
                  updatedAt: run.requestedAt,
                  history: {
                    messages: [],
                    coverage: "Earlier voice is saved in the conversation",
                    omittedItems: 0,
                  },
                },
              ]
            : [],
        });
        yield* harness.start;
        expect(harness.startTurn).toHaveBeenCalledTimes(1);
        expect(harness.startTurn.mock.calls[0]?.[0].message.text).toBe("Continue with blue");
        expect(harness.projection().runs.at(-1)?.status).toBe("running");
        expect(
          harness
            .projection()
            .turnItems.some((item) => item.type === "error" || item.type === "handoff"),
        ).toBe(false);
        expect(harness.projection().contextTransfers).toHaveLength(0);
        expect(harness.projection().providerThreads[0]?.nativeThreadRef?.nativeId).toBe(
          "side-chat-native",
        );
        expect(
          harness.projection().contextHandoffs.every((handoff) => handoff.delivery === undefined),
        ).toBe(true);
      }),
  );
}
