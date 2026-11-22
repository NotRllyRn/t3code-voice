import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ContextHandoffId,
  MessageId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { recordVoiceMessage } from "./VoiceConversation.ts";
import { create, layer, projectId, voice } from "./VoiceConversation.testkit.ts";
import {
  voiceHistoryBoundaryOrdinal,
  voiceHistoryHandoffFilter,
  voiceHistoryItemFilter,
} from "./VoiceHistory.ts";
import { prepareVoiceHistoryHandoffs } from "./VoiceHistoryDelivery.ts";

const fixture = Effect.fn("VoiceHistoryDelivery.test.fixture")(function* () {
  const threadId = ThreadId.make("thread:history-delivery");
  yield* create(threadId);
  yield* recordVoiceMessage({
    projectId,
    threadId,
    role: "user",
    text: "RECORDED_CONVERSATION",
    voice,
    creationSource: "web",
  });
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { run } = yield* threads.sendToThread({
    projectId,
    threadId,
    commandId: CommandId.make("execute"),
    messageId: MessageId.make("execution"),
    text: "EXECUTION_INPUT",
    attachments: [],
    mode: "queue",
    createdBy: "user",
    creationSource: "web",
  });
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const records = yield* store.getThreadRecords(threadId, ["runs", "providerThreads", "turnItems"]);
  const getThreadRecords = vi.fn(store.getThreadRecords);
  const persist = vi.fn(() => Effect.void);
  return {
    threadId,
    run,
    providerThread: records.providerThreads.find((thread) => thread.id === run.providerThreadId)!,
    runs: records.runs,
    turnItems: records.turnItems,
    contextHandoffs: [],
    effectiveHandoffs: [],
    alreadyDeliveredItemIds: new Set<string>(),
    nativeInputRunIds: new Set<string>(),
    legacyInputRunIds: new Set<string>(),
    sameNativeThread: false,
    getThreadRecords,
    persist,
  } satisfies Parameters<typeof prepareVoiceHistoryHandoffs>[0];
});

it.effect("queries before checkpoint reuse, saves once, and retains empty retry behavior", () =>
  Effect.gen(function* () {
    const input = yield* fixture();
    const prepared = yield* prepareVoiceHistoryHandoffs(input);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.history?.messages.map((message) => message.text)).toEqual([
      "RECORDED_CONVERSATION",
    ]);
    expect(input.persist).toHaveBeenCalledExactlyOnceWith(prepared[0]);
    expect(input.getThreadRecords).toHaveBeenCalledExactlyOnceWith(
      input.run.threadId,
      ["turnItems"],
      {
        voiceHistory: { throughOrdinal: input.run.voiceHistoryCutoffOrdinal, afterOrdinal: 0 },
        turnItemTypes: ["user_message", "assistant_message"],
      },
    );
    const saved = { ...prepared[0]!, summaryText: "SAVED_CHECKPOINT" };
    expect(yield* prepareVoiceHistoryHandoffs({ ...input, contextHandoffs: [saved] })).toEqual([
      saved,
    ]);
    expect(yield* prepareVoiceHistoryHandoffs({ ...input, effectiveHandoffs: [saved] })).toEqual([
      saved,
    ]);
    expect(input.persist).toHaveBeenCalledTimes(1);
    expect(input.getThreadRecords).toHaveBeenCalledTimes(3);
    const delivered = new Set(saved.history!.messages.map((message) => message.itemId));
    expect(
      yield* prepareVoiceHistoryHandoffs({
        ...input,
        contextHandoffs: [saved],
        alreadyDeliveredItemIds: delivered,
      }),
    ).toEqual([]);
    expect(input.getThreadRecords).toHaveBeenCalledTimes(4);
    expect(input.persist).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("absent cutoff performs no read; read and checkpoint failures propagate", () =>
  Effect.gen(function* () {
    const input = yield* fixture();
    expect(
      yield* prepareVoiceHistoryHandoffs({
        ...input,
        run: { ...input.run, voiceHistoryCutoffOrdinal: undefined },
      }),
    ).toBe(input.effectiveHandoffs);
    expect(input.getThreadRecords).not.toHaveBeenCalled();
    const readError = new ProjectionStore.ProjectionStoreReadError({
      threadId: input.run.threadId,
      cause: "history unavailable",
    });
    const failedRead: ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"] = () =>
      Effect.fail(readError);
    expect(
      yield* Effect.flip(prepareVoiceHistoryHandoffs({ ...input, getThreadRecords: failedRead })),
    ).toBe(readError);
    expect(input.persist).not.toHaveBeenCalled();
    const checkpointError = new Error("checkpoint unavailable");
    expect(
      yield* Effect.flip(
        prepareVoiceHistoryHandoffs({ ...input, persist: () => Effect.fail(checkpointError) }),
      ),
    ).toBe(checkpointError);
  }).pipe(Effect.provide(layer)),
);

it.effect("saved handoff eligibility uses run ordinals, independently of item cutoffs", () =>
  Effect.gen(function* () {
    const input = yield* fixture();
    const [handoff] = yield* prepareVoiceHistoryHandoffs(input);
    const before = { ...input.run, id: RunId.make("before-clear"), ordinal: 4 };
    const fresh = {
      ...input.run,
      id: RunId.make("clear"),
      ordinal: 5,
      freshContext: true,
      status: "completed" as const,
      voiceHistoryCutoffOrdinal: 500,
    };
    const after = { ...input.run, id: RunId.make("after-clear"), ordinal: 6 };
    const current = { ...input.run, ordinal: 10 };
    const eligible = voiceHistoryHandoffFilter(
      current,
      [before, fresh, after, current],
      input.turnItems,
    );
    expect(eligible({ ...handoff!, targetRunId: before.id })).toBe(false);
    expect(eligible({ ...handoff!, targetRunId: fresh.id })).toBe(false);
    expect(eligible({ ...handoff!, targetRunId: after.id })).toBe(true);
    const voiceItem = input.turnItems.find((item) => item.voice !== undefined)!;
    for (const [kind, status, startedAt, cutsHistory] of [
      ["scheduled", "completed", null, false],
      ["queued", "queued", null, false],
      ["cancelled", "cancelled", null, false],
      ["started-cancelled", "cancelled", fresh.requestedAt, true],
      ["rolled-back", "rolled_back", fresh.requestedAt, true],
    ] as const) {
      const source = {
        ...fresh,
        userMessageId: MessageId.make("fresh-prompt"),
        status,
        startedAt,
      };
      const turnItems =
        kind === "scheduled" && voiceItem.type === "user_message"
          ? [
              ...input.turnItems,
              {
                ...voiceItem,
                messageId: source.userMessageId,
                scheduledTaskId: ScheduledTaskId.make("task"),
              },
            ]
          : input.turnItems;
      const runs = [before, source, after, current];
      expect(voiceHistoryBoundaryOrdinal(current, runs, turnItems), kind).toBe(
        cutsHistory ? 500 : 0,
      );
      const prepared = yield* prepareVoiceHistoryHandoffs({
        ...input,
        run: current,
        runs,
        turnItems,
      });
      expect(
        prepared.flatMap((saved) => saved.history?.messages ?? []).map((message) => message.text),
        kind,
      ).toEqual(cutsHistory ? [] : ["RECORDED_CONVERSATION"]);
      expect(voiceHistoryItemFilter(current, runs, turnItems)(voiceItem), kind).toBe(!cutsHistory);
      expect(
        voiceHistoryHandoffFilter(
          current,
          runs,
          turnItems,
        )({ ...handoff!, targetRunId: before.id }),
        kind,
      ).toBe(!cutsHistory);
      expect(voiceHistoryItemFilter(source, runs, turnItems)(voiceItem), kind).toBe(false);
      expect(
        voiceHistoryHandoffFilter(source, runs, turnItems)({ ...handoff!, targetRunId: before.id }),
        kind,
      ).toBe(false);
    }

    expect(
      eligible({
        ...handoff!,
        id: ContextHandoffId.make("ordinary-handoff"),
        targetRunId: before.id,
      }),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);
