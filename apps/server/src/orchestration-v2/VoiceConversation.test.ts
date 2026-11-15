import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  OrchestrationV2Command,
  type OrchestrationV2VoiceMessage,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { recordVoiceMessage, sendRecordedVoiceMessage } from "./VoiceConversation.ts";
import { voiceMessageId } from "./VoiceHistory.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const isPublicCommand = Schema.is(OrchestrationV2Command);
const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:voice-history");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Recording must never open a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const foundation = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "voice-history" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);
const layer = ThreadManagement.layer.pipe(
  Layer.provideMerge(foundation),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
);
const voice: OrchestrationV2VoiceMessage = {
  sessionId: "voice-session",
  itemId: "input-one",
  sequence: 1,
  textKind: "final_user_transcript",
  delivery: "unknown",
};
const create = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Voice",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect(
  "records != executes; retries reuse the same message/item/run and reject conflicting finals",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:voice-record");
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* create(threadId);
      const input = {
        projectId,
        threadId,
        role: "user" as const,
        text: "Make the test pass",
        voice,
        creationSource: "web" as const,
      };
      const first = yield* recordVoiceMessage(input);
      yield* recordVoiceMessage(input);
      let projection = yield* store.getThreadRecords(threadId, [
        "messages",
        "turnItems",
        "runs",
        "providerTurns",
      ]);
      expect(projection.messages).toHaveLength(1);
      expect(projection.turnItems).toHaveLength(1);
      expect(projection.turnItems[0]).toMatchObject({
        runId: null,
        inputIntent: "conversation_only",
      });
      expect(projection.runs).toHaveLength(0);
      expect(projection.providerTurns).toHaveLength(0);
      const itemId = projection.turnItems[0]!.id;
      expect(
        (yield* Effect.flip(recordVoiceMessage({ ...input, text: "Different final" })))._tag,
      ).toBe("OrchestratorDispatchError");
      const execute = {
        projectId,
        threadId,
        messageId: first.messageId,
        sessionId: voice.sessionId,
      };
      const run = yield* sendRecordedVoiceMessage(execute);
      const retried = yield* sendRecordedVoiceMessage(execute);
      expect(retried.run.id).toBe(run.run.id);
      projection = yield* store.getThreadRecords(threadId, [
        "messages",
        "turnItems",
        "runs",
        "providerTurns",
      ]);
      expect(projection.messages).toHaveLength(1);
      expect(projection.runs).toHaveLength(1);
      expect(projection.messages[0]).toMatchObject({
        id: first.messageId,
        runId: run.run.id,
        voice,
      });
      expect(projection.turnItems.filter((item) => item.type === "user_message")).toHaveLength(1);
      expect(projection.turnItems.find((item) => item.id === itemId)).toMatchObject({
        runId: run.run.id,
        voice,
      });
      const queuedVoice = { ...voice, itemId: "input-two", sequence: 2 };
      const second = yield* recordVoiceMessage({
        ...input,
        text: "Then run the checks",
        voice: queuedVoice,
      });
      const beforeQueue = yield* store.getThreadRecords(threadId, ["turnItems"]);
      const secondItem = beforeQueue.turnItems.find((item) => item.voice?.itemId === "input-two")!;
      const queued = yield* sendRecordedVoiceMessage({ ...execute, messageId: second.messageId });
      expect(queued.delivery).toBe("queued");
      expect(queued.turnItem?.id).toBe(secondItem.id);
      expect(queued.turnItem?.voice).toEqual(queuedVoice);
      expect(
        queued.projection.messages.filter((message) => message.id === second.messageId),
      ).toHaveLength(1);
      expect(queued.run.voiceHistoryCutoffOrdinal).toBe(secondItem.ordinal);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "assistant output cannot dispatch; generation and playback remain distinct and interrupted is sticky",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:voice-assistant");
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* create(threadId);
      const reply = {
        ...voice,
        itemId: "reply",
        sequence: 2,
        responseId: "response-one",
        textKind: "generated_voice_reply" as const,
        delivery: "pending" as const,
      };
      const input = {
        projectId,
        threadId,
        role: "assistant" as const,
        text: "I can help with that.",
        voice: reply,
        creationSource: "server" as const,
      };
      const saved = yield* recordVoiceMessage(input);
      yield* recordVoiceMessage({
        ...input,
        voice: { ...reply, delivery: "interrupted", playedAudioMs: 250 },
      });
      yield* recordVoiceMessage({ ...input, voice: { ...reply, delivery: "drained" } });
      expect(
        (yield* Effect.flip(
          sendRecordedVoiceMessage({
            projectId,
            threadId,
            messageId: saved.messageId,
            sessionId: voice.sessionId,
          }),
        ))._tag,
      ).toBe("OrchestratorDispatchError");
      expect(
        (yield* Effect.flip(
          threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("forged-assistant-dispatch"),
            threadId,
            messageId: saved.messageId,
            text: input.text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          }),
        ))._tag,
      ).toBe("OrchestratorDispatchError");
      const projection = yield* store.getThreadRecords(threadId, ["messages", "runs", "turnItems"]);
      expect(projection.runs).toHaveLength(0);
      expect(projection.messages[0]).toMatchObject({
        text: input.text,
        voice: { delivery: "interrupted", playedAudioMs: 250 },
      });
      expect(projection.turnItems[0]?.voice?.delivery).toBe("interrupted");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "normal inputs stay after more than 100 voice-only messages, and repeated words keep distinct identities",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:long-voice-history");
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* create(threadId);
      yield* Effect.forEach(
        Array.from({ length: 102 }, (_, index) => index),
        (index) =>
          recordVoiceMessage({
            projectId,
            threadId,
            role: "user",
            text: "hello",
            creationSource: "web",
            voice: { ...voice, itemId: `greeting-${index}`, sequence: index },
          }),
        { discard: true },
      );
      const before = yield* store.getThreadRecords(threadId, ["messages", "turnItems", "runs"]);
      expect(before.messages).toHaveLength(102);
      expect(before.runs).toHaveLength(0);
      const sent = yield* threads.sendToThread({
        projectId,
        threadId,
        commandId: CommandId.make("normal-after-voice"),
        messageId: MessageId.make("message:normal-after-voice"),
        text: "Now inspect the tests",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      const normal = sent.projection.turnItems.find(
        (item) => item.type === "user_message" && item.runId === sent.run.id,
      )!;
      expect(normal.ordinal).toBeGreaterThan(
        Math.max(...before.turnItems.map((item) => item.ordinal)),
      );
      expect(sent.run.voiceHistoryCutoffOrdinal).toBe(102);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "retains project/session/mode authorization and refuses rewriting an already-recorded input",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:voice-scope");
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* create(threadId);
      const input = {
        projectId,
        threadId,
        role: "user" as const,
        text: "hello",
        voice,
        creationSource: "web" as const,
      };
      expect(
        (yield* Effect.flip(recordVoiceMessage({ ...input, projectId: ProjectId.make("other") })))
          ._tag,
      ).toBe("ThreadManagementThreadNotFoundError");
      const saved = yield* recordVoiceMessage(input);
      const otherThreadId = ThreadId.make("thread:foreign-voice-source");
      yield* create(otherThreadId);
      const foreign = yield* recordVoiceMessage({
        ...input,
        threadId: otherThreadId,
        voice: { ...voice, sessionId: "foreign-session" },
      });
      expect(
        (yield* Effect.flip(
          recordVoiceMessage({
            ...input,
            role: "assistant",
            voice: {
              ...voice,
              itemId: "forged-narration",
              responseId: "response",
              textKind: "generated_voice_reply",
              sourceMessageIds: [foreign.messageId],
            },
          }),
        ))._tag,
      ).toBe("OrchestratorDispatchError");
      expect(
        (yield* Effect.flip(
          sendRecordedVoiceMessage({
            projectId,
            threadId,
            messageId: saved.messageId,
            sessionId: "other-session",
          }),
        ))._tag,
      ).toBe("OrchestratorDispatchError");
      expect(
        (yield* Effect.flip(
          recordVoiceMessage({ ...input, voice: { ...voice, itemId: "other" } }).pipe(
            Effect.provideService(DispatchModeLimit, {
              runtimeMode: "approval-required",
              interactionMode: "default",
            }),
          ),
        ))._tag,
      ).toBe("OrchestratorThreadAboveModeLimitError");
      expect(
        (yield* Effect.flip(
          threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("rewrite-user"),
            threadId,
            messageId: saved.messageId,
            text: "Changed",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          }),
        ))._tag,
      ).toBe("OrchestratorDispatchError");
      expect(voiceMessageId("user", voice)).not.toBe(voiceMessageId("assistant", voice));
      expect(
        isPublicCommand({
          type: "voice.message.record",
          commandId: CommandId.make("public-record"),
          threadId,
          messageId: saved.messageId,
          role: "user",
          text: input.text,
          voice,
          createdBy: "user",
          creationSource: "web",
        }),
      ).toBe(false);
    }).pipe(Effect.provide(layer)),
);
