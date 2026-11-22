import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { recordVoiceMessage } from "../../orchestration-v2/VoiceConversation.ts";
import { create, makeLayer, projectId, voice } from "./testkit.ts";

it.effect(
  "file SQLite reopen preserves canonical voice, receipts, cutoff and interrupted delivery",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "voice-footprint-" });
      const databasePath = path.join(directory, "state.sqlite");
      const threadId = ThreadId.make("thread:durable-voice");
      const input = {
        projectId,
        threadId,
        role: "user" as const,
        text: "Inspect the fictional fixture",
        voice,
        creationSource: "web" as const,
      };
      const reply = {
        ...input,
        role: "assistant" as const,
        text: "I can inspect it; no task has started.",
        voice: {
          ...voice,
          itemId: "durable-reply",
          responseId: "durable-response",
          textKind: "generated_voice_reply" as const,
          delivery: "pending" as const,
        },
      };
      const second = {
        ...input,
        text: "Then check the result",
        voice: { ...voice, itemId: "durable-second", sequence: 2 },
      };
      const interrupted = {
        ...reply,
        voice: { ...reply.voice, delivery: "interrupted" as const, playedAudioMs: 125 },
      };
      const fields = ["messages", "turnItems", "runs", "providerTurns"] as const;
      const first = yield* Effect.gen(function* () {
        yield* create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const recorded = yield* recordVoiceMessage(input);
        const generated = yield* recordVoiceMessage(reply);
        yield* recordVoiceMessage(interrupted);
        expect((yield* store.getThreadRecords(threadId, fields)).runs).toEqual([]);
        const execute = {
          projectId,
          threadId,
          messageId: recorded.messageId,
          commandId: CommandId.make("durable-execute"),
          text: input.text,
          attachments: [],
          mode: "queue" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
        };
        const active = yield* threads.sendToThread(execute);
        const next = yield* recordVoiceMessage(second);
        const beforeQueue = yield* store.getThreadRecords(threadId, ["turnItems"]);
        const secondItem = beforeQueue.turnItems.find(
          (item) => item.voice?.itemId === second.voice.itemId,
        )!;
        const enqueue = {
          ...execute,
          commandId: CommandId.make("durable-queue"),
          messageId: next.messageId,
          text: second.text,
        };
        const queued = yield* threads.sendToThread(enqueue);
        expect(queued.delivery).toBe("queued");
        expect(queued.run.voiceHistoryCutoffOrdinal).toBe(secondItem.ordinal - 1);
        const cancel = {
          type: "queued-run.cancel" as const,
          commandId: CommandId.make("durable-cancel"),
          threadId,
          runId: queued.run.id,
        };
        const cancelled = yield* threads.dispatch(cancel);
        yield* recordVoiceMessage({
          ...input,
          text: "Conversation after the frozen cutoff",
          voice: { ...voice, itemId: "durable-late", sequence: 3 },
        });
        const state = yield* store.getThreadRecords(threadId, fields);
        expect(state.messages).toHaveLength(4);
        expect(state.turnItems.filter((item) => item.type === "user_message")).toHaveLength(3);
        expect(state.runs.map((run) => run.status)).toEqual(["starting", "cancelled"]);
        expect(state.providerTurns).toEqual([]);
        expect(state.messages.find((message) => message.id === generated.messageId)).toMatchObject({
          runId: null,
          text: reply.text,
          voice: { ...reply.voice, delivery: "interrupted", playedAudioMs: 125 },
        });
        expect(state.turnItems.find((item) => item.type === "assistant_message")?.voice).toEqual(
          interrupted.voice,
        );
        expect(state.messages.find((message) => message.id === recorded.messageId)).toMatchObject({
          runId: active.run.id,
          voice,
        });
        expect(state.turnItems.find((item) => item.id === secondItem.id)).toMatchObject({
          messageId: next.messageId,
          runId: queued.run.id,
          voice: second.voice,
          ordinal: secondItem.ordinal,
        });
        return {
          state,
          recorded,
          generated,
          next,
          execute,
          enqueue,
          active,
          queued,
          cancel,
          cancelled,
        };
      }).pipe(Effect.provide(makeLayer(databasePath)));

      // New layer build: new SQLite connections, stores, locks and receipt services.
      const events = yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const eventStore = yield* EventStore.EventStoreV2;
        expect(yield* store.getThreadRecords(threadId, fields)).toEqual(first.state);
        const sequence = yield* eventStore.latestSequence({ threadId });
        const recorded = yield* recordVoiceMessage(input);
        const generated = yield* recordVoiceMessage(reply);
        const next = yield* recordVoiceMessage(second);
        for (const [actual, original] of [
          [recorded, first.recorded],
          [generated, first.generated],
          [next, first.next],
        ] as const) {
          expect(actual.messageId).toBe(original.messageId);
          expect(actual.dispatch.replayed).toBe(true);
          expect(actual.dispatch.sequence).toBe(original.dispatch.sequence);
        }
        expect((yield* threads.sendToThread(first.execute)).run.id).toBe(first.active.run.id);
        expect((yield* threads.sendToThread(first.enqueue)).run.id).toBe(first.queued.run.id);
        const cancelled = yield* threads.dispatch(first.cancel);
        expect(cancelled.replayed).toBe(true);
        expect(cancelled.sequence).toBe(first.cancelled.sequence);
        yield* recordVoiceMessage(interrupted);
        expect(yield* eventStore.latestSequence({ threadId })).toBe(sequence);
        // A later playback report must not turn interrupted generation into heard speech.
        yield* recordVoiceMessage({ ...reply, voice: { ...reply.voice, delivery: "drained" } });
        expect(
          (yield* Effect.flip(recordVoiceMessage({ ...input, text: "Conflicting final" })))._tag,
        ).toBe("OrchestratorDispatchError");
        expect(yield* store.getThreadRecords(threadId, fields)).toEqual(first.state);
        return yield* Stream.runCollect(eventStore.read({ threadId }));
      }).pipe(Effect.provide(makeLayer(databasePath)));

      // Check the second close too: no in-memory cache can satisfy this read.
      yield* Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        expect(yield* store.getThreadRecords(threadId, fields)).toEqual(first.state);
      }).pipe(Effect.provide(makeLayer(databasePath)));

      // Reconstruct from durable events in another database, using the real projector.
      yield* Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        yield* Effect.forEach(events, (stored) => store.apply(stored.event), { discard: true });
        expect(yield* store.getThreadRecords(threadId, fields)).toEqual(first.state);
      }).pipe(
        Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
