import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectionStore from "./ProjectionStore.ts";
import { recordVoiceMessage } from "./VoiceConversation.ts";
import { voiceTurnItemId } from "./VoiceHistory.ts";
import { create, makeLayer, projectId, voice } from "../voice/footprint/testkit.ts";

it.effect(
  "canonical assistant updates read source IDs and retain position without allocating",
  () => {
    const reads: Array<{
      fields: ReadonlyArray<ProjectionStore.ProjectionRecordField>;
      filter: ProjectionStore.ProjectionRecordFilter | undefined;
    }> = [];
    let allocations = 0;
    let fullReads = 0;
    const layer = makeLayer(undefined, {
      wrapProjectionStore: (store) => ({
        ...store,
        getThreadRecords: (id, fields, filter) => {
          reads.push({ fields, filter });
          return store.getThreadRecords(id, fields, filter);
        },
        getNextTurnItemOrdinal: (id) => {
          allocations++;
          return store.getNextTurnItemOrdinal(id);
        },
        getThreadProjection: (id) => {
          fullReads++;
          return store.getThreadProjection(id);
        },
      }),
    });
    return Effect.gen(function* () {
      const threadId = ThreadId.make("thread:canonical-targeted-update");
      yield* create(threadId);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const input = {
        projectId,
        threadId,
        role: "assistant" as const,
        text: "Synthetic source reply",
        creationSource: "web" as const,
        voice: {
          ...voice,
          itemId: "source-reply",
          responseId: "source-response",
          textKind: "generated_voice_reply" as const,
          delivery: "pending" as const,
        },
      };
      const source = yield* recordVoiceMessage(input);
      const reply = {
        ...input,
        text: "Synthetic sourced reply",
        voice: {
          ...input.voice,
          itemId: "sourced-reply",
          responseId: "sourced-response",
          sourceMessageIds: [source.messageId],
        },
      };
      const recorded = yield* recordVoiceMessage(reply);
      const before = yield* store.getThreadRecords(threadId, ["messages", "turnItems"]);
      const original = before.messages.find((message) => message.id === recorded.messageId)!;
      const originalItem = before.turnItems.find(
        (item) => item.id === voiceTurnItemId(recorded.messageId),
      )!;
      reads.length = 0;
      allocations = 0;
      fullReads = 0;
      yield* TestClock.adjust("1 second");
      yield* recordVoiceMessage({
        ...reply,
        voice: { ...reply.voice, delivery: "interrupted", playedAudioMs: 100 },
      });
      yield* recordVoiceMessage({ ...reply, voice: { ...reply.voice, delivery: "drained" } });
      expect(allocations).toBe(0);
      expect(fullReads).toBe(0);
      const targeted = reads.filter((read) => read.fields.length === 2);
      const commandReads = reads.filter((read) => read.fields.length > 2);
      expect(reads).toHaveLength(6);
      expect(reads.filter((read) => read.fields.length === 0)).toHaveLength(2);
      expect(commandReads).toHaveLength(2);
      expect(commandReads.every((read) => read.filter?.messageRoles?.join() === "user")).toBe(true);
      expect(targeted).toHaveLength(2);
      for (const read of targeted) {
        expect(read.fields).toEqual(["messages", "turnItems"]);
        expect(read.filter).toEqual({
          messageIds: [recorded.messageId, source.messageId],
          turnItemIds: [voiceTurnItemId(recorded.messageId), voiceTurnItemId(source.messageId)],
        });
      }
      const after = yield* store.getThreadRecords(threadId, ["messages", "turnItems"]);
      expect(after.messages).toHaveLength(2);
      expect(after.turnItems).toHaveLength(2);
      const updated = after.messages.find((message) => message.id === recorded.messageId)!;
      expect(updated).toEqual({
        ...original,
        updatedAt: updated.updatedAt,
        voice: { ...reply.voice, delivery: "interrupted", playedAudioMs: 100 },
      });
      expect(updated.updatedAt).not.toEqual(original.updatedAt);
      const updatedItem = after.turnItems.find((item) => item.id === originalItem.id)!;
      expect(updatedItem).toEqual({
        ...originalItem,
        updatedAt: updated.updatedAt,
        voice: updated.voice,
      });
    }).pipe(Effect.provide(layer));
  },
);
