import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

const threadId = ThreadId.make("thread:restart");
const instanceId = ProviderInstanceId.make("codex");
const sessionId = ProviderSessionId.make("session:restart");
const scratchProjectId = ProjectId.make("project:scratch");

it.effect.each([
  { guarded: true, currentDriver: "pi", queued: false },
  { guarded: true, currentDriver: "codex", queued: false },
  { guarded: false, currentDriver: "pi", queued: false },
  { guarded: true, currentDriver: "pi", queued: true },
] as const)(
  "retires clean starts across restart chains (guarded=$guarded, driver=$currentDriver, queued=$queued)",
  ({ guarded, currentDriver, queued }) => {
    let spawns = 0;
    const currentAdapter = {
      instanceId,
      driver: ProviderDriverKind.make(currentDriver),
      getCapabilities: () =>
        Effect.succeed({
          ...CodexProviderCapabilitiesV2,
        }),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => {
        spawns += 1;
        return Effect.fail(
          new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver: ProviderDriverKind.make(currentDriver),
            providerSessionId: sessionId,
          }),
        );
      },
    } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
    const database = SqlitePersistence.layerMemory;
    const testLayer = Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      EffectOutbox.layer.pipe(Layer.provide(database)),
      IdAllocator.layer,
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
      ProviderReplayHarness.layerWithRegistry(
        { name: "clean-restart" },
        ProviderAdapterRegistry.layerFromAdapters([currentAdapter]),
        {
          databaseLayer: database,
          runEffectWorker: false,
          continueThreadsAfterServerUpdate: true,
        },
      ),
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const recovery = yield* ProviderRuntimeRecovery.make;
      const time = yield* DateTime.now;
      const selection = { instanceId, model: "test-model" };
      const pi = ProviderDriverKind.make("pi");
      const constraint = { instanceId, driver: "pi" as const, environmentMode: "clean" as const };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("clean-restart:create"),
        threadId,
        projectId: scratchProjectId,
        title: "Clean restart",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("clean-restart:source"),
        threadId,
        messageId: MessageId.make("clean-restart:message"),
        text: "Start",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const initial = yield* projections.getThreadProjection(threadId);
      const source = initial.runs[0]!;
      const providerThread = initial.providerThreads[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("clean-restart:running"),
            type: "run.updated",
            threadId,
            occurredAt: time,
            payload: {
              ...source,
              ordinal: 2,
              status: "running",
              startedAt: time,
              ...(guarded
                ? {
                    workspacePreparation: {
                      type: "worktree" as const,
                      baseRef: "main",
                      enforceNoSetupScripts: true,
                      cleanProviderConstraint: constraint,
                    },
                  }
                : {}),
            },
          },
          {
            id: EventId.make("clean-restart:session"),
            type: "provider-session.attached",
            threadId,
            occurredAt: time,
            payload: {
              id: providerThread.providerSessionId!,
              driver: pi,
              providerInstanceId: instanceId,
              status: "ready",
              cwd: process.cwd(),
              model: selection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: time,
              updatedAt: time,
              lastError: null,
            },
          },
          {
            id: EventId.make("clean-restart:provider-thread"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: time,
            payload: {
              ...providerThread,
              driver: pi,
              nativeThreadRef: { driver: pi, nativeId: "native:pi", strength: "strong" },
              status: "active",
            },
          },
          {
            id: EventId.make("clean-restart:turn"),
            type: "provider-turn.updated",
            threadId,
            occurredAt: time,
            payload: {
              id: ProviderTurnId.make("clean-restart:turn"),
              providerThreadId: providerThread.id,
              nodeId: source.rootNodeId!,
              runAttemptId: source.activeAttemptId!,
              nativeTurnRef: { driver: pi, nativeId: "native:turn", strength: "strong" },
              ordinal: 1,
              status: "running",
              startedAt: time,
              completedAt: null,
            },
          },
        ],
      });
      for (let restart = 0; restart < 2; restart += 1) {
        yield* TestClock.adjust("1 milli");
        yield* recovery.reconcile("startup");
        if (queued) {
          yield* sink.write({
            events: [
              {
                id: EventId.make("clean-restart:blocker"),
                type: "run.created",
                threadId,
                occurredAt: time,
                payload: {
                  ...source,
                  id: RunId.make("clean-restart:blocker"),
                  ordinal: 1,
                  status: "waiting",
                  startedAt: time,
                  completedAt: time,
                },
              },
            ],
          });
        }
        assert.equal(yield* worker.drain(1), 1);
        const saved = yield* projections.getThreadProjection(threadId);
        assert.lengthOf(saved.runs, restart + 2 + Number(queued));
        const continuation = saved.runs.at(-1)!;
        assert.equal(continuation.restartContinuationOfRunId, saved.runs.at(-2)!.id);
        assert.deepEqual(continuation.workspacePreparation, undefined);
        assert.equal(continuation.status, queued ? "queued" : "starting");
        assert.equal(spawns, 0);
        if (queued) return;
        if (restart === 0 && currentDriver === "codex") {
          // Recovery must also protect a chain admitted before constraint propagation.
          yield* sink.write({
            events: [
              {
                id: EventId.make("clean-restart:legacy-continuation"),
                type: "run.updated",
                threadId,
                occurredAt: time,
                payload: { ...continuation, workspacePreparation: undefined },
              },
            ],
          });
        }
      }
      yield* worker.drain();
      assert.equal(spawns, guarded ? 0 : 1);
    }).pipe(Effect.provide(testLayer));
  },
);
