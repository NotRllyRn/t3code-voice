import { expect, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import { recordVoiceMessage } from "../../orchestration-v2/VoiceConversation.ts";
import { makeLiveAgentSession } from "../liveAgentSession.ts";
import { readLiveHistory } from "../liveHistory.ts";
import { encodeNativeLiveAppend, type NativeLiveAppendMessage } from "../liveProtocol.ts";
import { create, makeLayer, projectId, putMessage, voice } from "./testkit.ts";

const layer = Layer.mergeAll(
  makeLayer(),
  Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: () => Effect.die("History seed must never launch work"),
  }),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/fixture/projects",
  }),
);
const send = (threadId: ThreadId, id: string, freshContext = false) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return yield* threads.sendToThread({
      projectId,
      threadId,
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      text: id,
      attachments: [],
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
      ...(freshContext ? { freshContext: true } : {}),
    });
  });

it.effect(
  "real SQL voice reads enforce empty IDs, thread ownership and the ordered (after, through] range",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:sql-voice");
      const other = ThreadId.make("thread:sql-foreign");
      yield* create(threadId);
      yield* create(other);
      for (const ordinal of [8, 4, 7, 1, 5]) {
        yield* putMessage({
          threadId,
          id: `voice-${ordinal}`,
          ordinal,
          voice: { ...voice, itemId: `sql-${ordinal}`, sequence: ordinal },
        });
      }
      yield* putMessage({ threadId, id: "ordinary-six", ordinal: 6 });
      const foreign = yield* putMessage({
        threadId: other,
        id: "foreign-seven",
        ordinal: 7,
        voice,
      });
      expect(
        (yield* store.getThreadRecords(threadId, ["turnItems"], { turnItemIds: [] })).turnItems,
      ).toEqual([]);
      const selected = yield* store.getThreadRecords(threadId, ["turnItems"], {
        turnItemIds: [TurnItemId.make("item:voice-8"), foreign.item.id],
      });
      expect(selected.turnItems.map((item) => item.id)).toEqual(["item:voice-8"]);
      const bounded = yield* store.getThreadRecords(threadId, ["turnItems"], {
        voiceHistory: { afterOrdinal: 4, throughOrdinal: 7 },
      });
      expect(bounded.turnItems.map((item) => [item.id, item.ordinal])).toEqual([
        ["item:voice-5", 5],
        ["item:voice-7", 7],
      ]);
      const intersected = yield* store.getThreadRecords(threadId, ["turnItems"], {
        turnItemIds: [
          TurnItemId.make("item:voice-4"),
          TurnItemId.make("item:voice-7"),
          foreign.item.id,
        ],
        voiceHistory: { afterOrdinal: 4, throughOrdinal: 7 },
      });
      expect(intersected.turnItems.map((item) => item.id)).toEqual(["item:voice-7"]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "Live seed reads real local final bodies, excluding inherited, foreign, rollback, streaming and notifications",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const parentId = ThreadId.make("thread:private-parent");
      const threadId = ThreadId.make("thread:local-child");
      yield* create(parentId);
      const parent = yield* send(parentId, "parent-input");
      yield* store.apply({
        id: EventId.make("event:parent-ended"),
        type: "run.updated",
        threadId: parentId,
        occurredAt: yield* DateTime.now,
        payload: { ...parent.run, status: "completed" },
      });
      yield* putMessage({
        threadId: parentId,
        id: "PRIVATE_PARENT",
        ordinal: 20,
        role: "assistant",
        runId: parent.run.id,
      });
      yield* create(threadId);
      const shell = (yield* store.getThreadProjection(threadId)).thread;
      yield* store.apply({
        id: EventId.make("event:synthetic-fork"),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: {
          ...shell,
          forkedFrom: { type: "run", threadId: parentId, runId: parent.run.id },
        },
      });
      const inherited = yield* threads.getTimelinePage(threadId, {
        view: "messages",
        beforePosition: Infinity,
        limit: 32,
      });
      expect(
        inherited.items.some(
          (row) => row.visibility === "inherited" && row.sourceThreadId === parentId,
        ),
      ).toBe(true);
      expect(
        inherited.items.some(
          (row) =>
            row.item.type === "assistant_message" &&
            row.item.messageId === MessageId.make("PRIVATE_PARENT"),
        ),
      ).toBe(true);
      expect((yield* readLiveHistory(threadId)).messages).toEqual([]);

      const rolledBack = yield* send(threadId, "ROLLBACK_INPUT");
      yield* putMessage({
        threadId,
        id: "ROLLBACK_REPLY",
        ordinal: 2,
        role: "assistant",
        runId: rolledBack.run.id,
      });
      yield* store.apply({
        id: EventId.make("event:rollback"),
        type: "run.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: { ...rolledBack.run, status: "rolled_back" },
      });
      yield* putMessage({ threadId, id: "local-human", ordinal: 3 });
      const answer = yield* putMessage({
        threadId,
        id: "local-answer",
        ordinal: 4,
        role: "assistant",
        voice: {
          ...voice,
          itemId: "local-answer",
          textKind: "generated_voice_reply",
          delivery: "interrupted",
        },
      });
      yield* putMessage({
        threadId,
        id: "STREAMING_ITEM",
        ordinal: 5,
        role: "assistant",
        streaming: false,
        itemStreaming: true,
      });
      yield* putMessage({
        threadId,
        id: "STREAMING_BODY",
        ordinal: 6,
        role: "assistant",
        streaming: true,
        itemStreaming: false,
      });
      yield* putMessage({
        threadId,
        id: "NOTIFICATION_BODY",
        ordinal: 7,
        notification: {
          source: { kind: "monitor" },
          outcome: "updated",
          summary: "Synthetic update",
        },
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-answer"),
        type: "turn-item.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: {
          ...answer.item,
          id: TurnItemId.make("item:duplicate-answer"),
          ordinal: 8,
          text: "ITEM_BODY_MUST_NOT_REPLACE_CANONICAL_MESSAGE",
        },
      });
      // A valid row in another real thread must never enter this thread's history.
      yield* putMessage({ threadId: parentId, id: "FOREIGN_LATEST", ordinal: 99 });
      const expected = [
        { role: "user", text: "local-human" },
        { role: "assistant", text: "local-answer", voice: answer.message.voice },
      ];
      expect((yield* readLiveHistory(threadId)).messages).toEqual(expected);
      const wire: NativeLiveAppendMessage[] = [];
      const before = yield* store.getThreadRecords(threadId, ["messages", "turnItems", "runs"]);
      const agent = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "history-sink",
        onBound: () => {},
        send: () => Effect.void,
        append: (event) =>
          Effect.sync(() => {
            wire.push(...encodeNativeLiveAppend(event));
          }),
      });
      const initialContext = yield* agent.seed;
      expect(yield* agent.seed).toBe(initialContext);
      expect(wire).toEqual([]);
      const seed = JSON.parse(initialContext ?? "null");
      expect(seed).toMatchObject({ source: "T3_bound_history", threadId, messages: expected });
      expect(seed.runs).toEqual([]);
      expect(yield* store.getThreadRecords(threadId, ["messages", "turnItems", "runs"])).toEqual(
        before,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "fresh context excludes voice at the cutoff and older runs while retaining its own input and later conversation",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:fresh-live");
      yield* create(threadId);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const old = yield* send(threadId, "OLD_TYPED");
      yield* store.apply({
        id: EventId.make("event:old-ended"),
        type: "run.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: { ...old.run, status: "completed" },
      });
      const boundary = yield* recordVoiceMessage({
        projectId,
        threadId,
        role: "user",
        text: "VOICE_AT_BOUNDARY",
        voice,
        creationSource: "web",
      });
      const before = yield* store.getThreadRecords(threadId, ["turnItems"]);
      const boundaryItem = before.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === boundary.messageId,
      )!;
      const fresh = yield* send(threadId, "FRESH_INPUT", true);
      expect(fresh.run.voiceHistoryCutoffOrdinal).toBe(boundaryItem.ordinal);
      expect((yield* readLiveHistory(threadId)).messages).toEqual([
        { role: "user", text: "FRESH_INPUT" },
      ]);
      const lateVoice = { ...voice, itemId: "after-fresh", sequence: 2 };
      yield* recordVoiceMessage({
        projectId,
        threadId,
        role: "user",
        text: "AFTER_FRESH",
        voice: lateVoice,
        creationSource: "web",
      });
      expect((yield* readLiveHistory(threadId)).messages).toEqual([
        { role: "user", text: "FRESH_INPUT" },
        { role: "user", text: "AFTER_FRESH", voice: lateVoice },
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "Live history keeps at most four newest messages and bounds encoded UTF-8 JSON, including escapes",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:bounded-live");
      yield* create(threadId);
      for (let ordinal = 1; ordinal <= 6; ordinal++) {
        yield* putMessage({ threadId, id: `small-${ordinal}`, ordinal });
      }
      expect((yield* readLiveHistory(threadId)).messages.map((message) => message.text)).toEqual([
        "small-3",
        "small-4",
        "small-5",
        "small-6",
      ]);
      const large = [7, 8, 9].map((ordinal) => ({
        role: "user" as const,
        text: `escaped-${ordinal}:${'🙂"\\\n'.repeat(450)}`,
      }));
      for (let index = 0; index < large.length; index++) {
        yield* putMessage({
          threadId,
          id: `large-${index}`,
          ordinal: 7 + index,
          text: large[index]!.text,
        });
      }
      expect(JSON.stringify(large).length).toBeLessThan(12000);
      expect(Buffer.byteLength(JSON.stringify(large), "utf8")).toBeGreaterThan(12000);
      const history = yield* readLiveHistory(threadId);
      expect(history.messages).toEqual([large[1], large[2]]);
      expect(Buffer.byteLength(JSON.stringify(history.messages), "utf8")).toBeLessThanOrEqual(
        12000,
      );
    }).pipe(Effect.provide(layer)),
);
