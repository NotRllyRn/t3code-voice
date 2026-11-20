import { expect, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { recordVoiceMessage } from "./VoiceConversation.ts";
import { voiceTurnItemId } from "./VoiceHistory.ts";
import { create, makeLayer, projectId, voice } from "../voice/footprint/testkit.ts";

it.effect.each(["queue_after_active", "start_immediately"] as const)(
  "canonical %s dispatch keeps targeted read order and replay skips ordinal reads",
  (mode) => {
    const reads: Array<
      | {
          type: "records";
          fields: ReadonlyArray<ProjectionStore.ProjectionRecordField>;
          filter: ProjectionStore.ProjectionRecordFilter | undefined;
        }
      | { type: "ordinal" | "full" }
    > = [];
    const layer = makeLayer(undefined, {
      wrapProjectionStore: (store) => ({
        ...store,
        getThreadRecords: (id, fields, filter) =>
          Effect.sync(() => reads.push({ type: "records", fields, filter })).pipe(
            Effect.andThen(store.getThreadRecords(id, fields, filter)),
          ),
        getNextTurnItemOrdinal: (id) =>
          Effect.sync(() => reads.push({ type: "ordinal" })).pipe(
            Effect.andThen(store.getNextTurnItemOrdinal(id)),
          ),
        getThreadProjection: (id) =>
          Effect.sync(() => reads.push({ type: "full" })).pipe(
            Effect.andThen(store.getThreadProjection(id)),
          ),
      }),
    });
    return Effect.gen(function* () {
      const threadId = ThreadId.make(`thread:dispatch-reads:${mode}`);
      yield* create(threadId);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventStore.EventStoreV2;
      const input = {
        projectId,
        threadId,
        role: "user" as const,
        text: "Synthetic canonical input",
        creationSource: "web" as const,
        voice,
      };
      yield* recordVoiceMessage({
        ...input,
        text: "Earlier conversation",
        voice: { ...voice, itemId: "earlier" },
      });
      const saved = yield* recordVoiceMessage(input);
      const before = yield* store.getThreadRecords(threadId, ["messages", "turnItems"]);
      const original = before.messages.find((message) => message.id === saved.messageId)!;
      const originalItem = before.turnItems.find(
        (item) => item.id === voiceTurnItemId(saved.messageId),
      )!;
      yield* recordVoiceMessage({
        ...input,
        role: "assistant",
        text: "Later reply stays outside this execution",
        voice: {
          ...voice,
          itemId: "later-reply",
          responseId: "later-response",
          textKind: "generated_voice_reply",
        },
      });
      yield* TestClock.adjust("1 second");
      const command = {
        type: "message.dispatch" as const,
        commandId: CommandId.make(`dispatch:${mode}`),
        threadId,
        messageId: saved.messageId,
        text: input.text,
        attachments: [],
        dispatchMode: { type: mode },
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      reads.length = 0;
      yield* orchestrator.dispatch(command);
      const firstReads = [...reads];
      expect(firstReads).toEqual([
        expect.objectContaining({
          type: "records",
          filter: expect.objectContaining({
            messageRoles: ["user"],
            sinceLastCompaction: { keepMessageId: saved.messageId, keepRunIds: [] },
          }),
        }),
        {
          type: "records",
          fields: ["messages", "turnItems"],
          filter: {
            messageIds: [saved.messageId],
            turnItemIds: [voiceTurnItemId(saved.messageId)],
          },
        },
        { type: "ordinal" },
        { type: "ordinal" },
      ]);
      const after = yield* store.getThreadRecords(threadId, ["messages", "turnItems", "runs"]);
      expect(after.runs).toHaveLength(1);
      expect(after.runs[0]!.voiceHistoryCutoffOrdinal).toBe(originalItem.ordinal - 1);
      const executed = after.messages.find((message) => message.id === saved.messageId)!;
      expect(executed).toMatchObject({ voice, createdAt: original.createdAt });
      expect(executed.updatedAt).not.toEqual(original.updatedAt);
      expect(after.turnItems.find((item) => item.id === originalItem.id)).toMatchObject({
        voice,
        ordinal: originalItem.ordinal,
        startedAt: originalItem.startedAt,
        completedAt: originalItem.completedAt,
        inputIntent: "turn_start",
        runId: after.runs[0]!.id,
      });
      reads.length = 0;
      const replayCommandId = CommandId.make(`canonical-replay:${mode}`);
      yield* orchestrator.dispatch({ ...command, commandId: replayCommandId });
      expect(reads).toEqual(firstReads.slice(0, 2));
      const acknowledgment = yield* events
        .readByCommandId({ commandId: replayCommandId })
        .pipe(Stream.runCollect);
      expect(acknowledgment).toHaveLength(1);
      expect(acknowledgment[0]!.event).toMatchObject({
        type: "thread.metadata-updated",
        threadId,
      });
      expect(yield* store.getThreadRecords(threadId, ["messages", "turnItems", "runs"])).toEqual(
        after,
      );
      reads.length = 0;
      yield* orchestrator.dispatch(command);
      expect(reads).toEqual([]);
      reads.length = 0;
      yield* orchestrator.dispatch({
        ...command,
        commandId: CommandId.make(`typed:${mode}`),
        messageId: MessageId.make(`typed:${mode}`),
        text: "Typed queued input",
        dispatchMode: { type: "queue_after_active" },
      });
      expect(reads).toEqual([
        expect.objectContaining({
          type: "records",
          filter: expect.objectContaining({
            messageRoles: ["user"],
            sinceLastCompaction: {
              keepMessageId: MessageId.make(`typed:${mode}`),
              keepRunIds: [],
            },
          }),
        }),
        {
          type: "records",
          fields: ["messages", "turnItems"],
          filter: {
            messageIds: [MessageId.make(`typed:${mode}`)],
            turnItemIds: [voiceTurnItemId(MessageId.make(`typed:${mode}`))],
          },
        },
        { type: "ordinal" },
      ]);
      const queued = yield* store.getThreadRecords(threadId, ["runs"]);
      expect(queued.runs).toHaveLength(2);
      expect(queued.runs[1]).toMatchObject({ status: "queued", voiceHistoryCutoffOrdinal: 3 });
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "queued canonical input keeps identity, message time and pending item times when started",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:canonical-queue-start");
      yield* create(threadId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const command = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("queue-start:active"),
        threadId,
        messageId: MessageId.make("queue-start:active"),
        text: "Active typed input",
        attachments: [],
        dispatchMode: { type: "queue_after_active" as const },
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      yield* orchestrator.dispatch(command);
      const recorded = yield* recordVoiceMessage({
        projectId,
        threadId,
        role: "user",
        text: "Queued canonical input",
        creationSource: "web",
        voice,
      });
      const before = yield* store.getThreadRecords(threadId, ["messages", "turnItems", "runs"]);
      const message = before.messages.find((item) => item.id === recorded.messageId)!;
      const item = before.turnItems.find(
        (item) => item.id === voiceTurnItemId(recorded.messageId),
      )!;
      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        ...command,
        commandId: CommandId.make("queue-start:voice"),
        messageId: recorded.messageId,
        text: message.text,
      });
      const queued = yield* store.getThreadRecords(threadId, ["messages", "turnItems", "runs"]);
      expect(queued.runs[1]).toMatchObject({
        status: "queued",
        voiceHistoryCutoffOrdinal: item.ordinal - 1,
      });
      expect(queued.messages.find((entry) => entry.id === message.id)).toMatchObject({
        voice,
        createdAt: message.createdAt,
      });
      expect(queued.turnItems.find((entry) => entry.id === item.id)).toMatchObject({
        ...item,
        runId: queued.runs[1]!.id,
        nodeId: queued.runs[1]!.rootNodeId,
        providerThreadId: queued.runs[1]!.providerThreadId,
        inputIntent: "queued_turn",
        status: "pending",
        startedAt: null,
        completedAt: null,
        updatedAt: yield* DateTime.now,
      });
      yield* store.apply({
        id: EventId.make("queue-start:active-ended"),
        type: "run.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: { ...before.runs[0]!, status: "completed" },
      });
      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("queue-start:resume"),
        threadId,
      });
      const started = yield* store.getThreadRecords(threadId, ["messages", "turnItems", "runs"]);
      expect(started.runs[1]).toMatchObject({
        id: queued.runs[1]!.id,
        status: "starting",
        voiceHistoryCutoffOrdinal: item.ordinal - 1,
      });
      expect(started.messages.find((entry) => entry.id === message.id)).toMatchObject({
        voice,
        createdAt: message.createdAt,
      });
      expect(started.turnItems.filter((entry) => entry.id === item.id)).toHaveLength(1);
      expect(started.turnItems.find((entry) => entry.id === item.id)).toMatchObject({
        ordinal: item.ordinal,
        voice,
        startedAt: null,
        completedAt: null,
        runId: queued.runs[1]!.id,
        inputIntent: "queued_turn",
      });
    }).pipe(Effect.provide(makeLayer())),
);
