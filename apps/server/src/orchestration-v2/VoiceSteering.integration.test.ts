import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { recordVoiceMessage } from "./VoiceConversation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { sendLiveDelegation } from "../voice/liveAgentSession.ts";

it.effect.each(["live", "queued"] as const)(
  "%s voice steers once and preserves recorded identity",
  (mode) =>
    Effect.gen(function* () {
      const driver = ProviderDriverKind.make("codex"),
        instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "test-model" };
      const capabilities = CodexProviderCapabilitiesV2;
      const cwd = yield* checkpointWorkspace(`voice-steer-${mode}`);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const steered: string[] = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: (turn) =>
                Effect.sync(() => {
                  steered.push(turn.message.text);
                }),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };

      const database = SqlitePersistence.layerMemory;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = ThreadId.make(`thread:voice-steer-${mode}`),
          projectId = ProjectId.make(`project:voice-steer-${mode}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId,
          title: "Voice steering",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start"),
          threadId,
          messageId: MessageId.make("initial"),
          text: "Implement the fixture",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const voice = {
          sessionId: "voice-session",
          itemId: "spoken-correction",
          sequence: 1,
          textKind: "final_user_transcript" as const,
          delivery: "unknown" as const,
        };
        const text = "Use blue instead of amber";
        const recorded = yield* recordVoiceMessage({
          projectId,
          threadId,
          role: "user",
          text,
          voice,
          creationSource: "web",
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        const original = before.turnItems.find(
          (i) => i.type === "user_message" && i.messageId === recorded.messageId,
        )!;
        const originalMessage = before.messages.find((m) => m.id === recorded.messageId)!;
        if (mode === "live") {
          const input = {
            projectId,
            threadId,
            sessionId: voice.sessionId,
            delegationId: "correction",
            userTurnId: voice.itemId,
            userTranscript: text,
            expectedModelSelection: modelSelection,
          };
          const delivered = yield* sendLiveDelegation(input);
          expect(delivered.delivery).toBe("steered");
          yield* sendLiveDelegation(input);
        } else {
          const queued = yield* threads.sendToThread({
            projectId,
            threadId,
            messageId: recorded.messageId,
            commandId: CommandId.make("queue"),
            text,
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          });
          expect(queued.delivery).toBe("queued");
          expect(queued.turnItem?.startedAt).toEqual(original.startedAt);
          const command = {
            type: "queued-message.promote-to-steer" as const,
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: queued.run.id,
            targetRunId: started[0]!.runId,
          };
          yield* orchestrator.dispatch(command);
          yield* orchestrator.dispatch(command);
        }
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(threadId);
        expect(steered).toEqual([text]);
        expect(started).toHaveLength(1);
        expect(after.runs.filter((r) => r.status === "queued")).toHaveLength(0);
        const messages = after.messages.filter((m) => m.id === recorded.messageId);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          voice,
          text,
          runId: started[0]!.runId,
          createdAt: originalMessage.createdAt,
        });
        const items = after.turnItems.filter(
          (i) => i.type === "user_message" && i.messageId === recorded.messageId,
        );
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          id: original.id,
          ordinal: original.ordinal,
          voice,
          text,
          startedAt: original.startedAt,
          completedAt: original.completedAt,
          runId: started[0]!.runId,
        });
      }).pipe(
        Effect.provide(
          ThreadManagement.layer.pipe(
            Layer.provideMerge(
              ProviderReplayHarness.layerWithRegistry(
                { name: `voice-steer-${mode}` },
                ProviderAdapterRegistry.layerSingle(adapter),
                { runEffectWorker: false, databaseLayer: database },
              ),
            ),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
          ),
        ),
      );
    }),
);
