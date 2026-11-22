import { expect, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { recordVoiceMessage } from "../../orchestration-v2/VoiceConversation.ts";
import { sendLiveDelegation } from "../liveAgentSession.ts";
import { create, makeLayer, projectId, voice } from "./testkit.ts";

it.effect(
  "typed dispatch wins real lock contention; stale Live admission leaves speech and queued work unchanged",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:live-admission-contention");
      const typedEntered = yield* Deferred.make<void>();
      const releaseTyped = yield* Deferred.make<void>();
      const stalePreflight = yield* Deferred.make<void>();
      let holdTyped = false;
      let observePreflight = false;
      const layer = makeLayer(undefined, {
        wrapProjectionStore: (store) => ({
          ...store,
          // The ordinal allocation occurs inside dispatch's thread lock.
          getNextTurnItemOrdinal: (id) =>
            Effect.gen(function* () {
              if (id === threadId && holdTyped) {
                holdTyped = false;
                yield* Deferred.succeed(typedEntered, undefined);
                yield* Deferred.await(releaseTyped);
              }
              return yield* store.getNextTurnItemOrdinal(id);
            }),
          getThreadRecords: (id, fields, filter) =>
            Effect.gen(function* () {
              const records = yield* store.getThreadRecords(id, fields, filter);
              if (
                id === threadId &&
                observePreflight &&
                fields.length === 2 &&
                fields.some((field) => field === "runs") &&
                fields.some((field) => field === "providerTurns")
              ) {
                observePreflight = false;
                yield* Deferred.succeed(stalePreflight, undefined);
              }
              return records;
            }),
        }),
      });
      yield* Effect.gen(function* () {
        yield* create(threadId);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
        const model = (yield* store.getThreadShell(threadId))!.modelSelection;
        const firstVoice = { ...voice, sessionId: "admission", itemId: "accepted-human" };
        yield* recordVoiceMessage({
          projectId,
          threadId,
          role: "user",
          text: "Inspect the fixture",
          voice: firstVoice,
          creationSource: "web",
        });
        const acceptedInput = {
          projectId,
          threadId,
          sessionId: firstVoice.sessionId,
          delegationId: "accepted",
          userTurnId: firstVoice.itemId,
          userTranscript: "Inspect the fixture",
          expectedUserMessageCount: 0,
          expectedModelSelection: model,
        };
        const accepted = yield* sendLiveDelegation(acceptedInput);
        const receiptId = CommandId.make("live_execute_admission_accepted");
        const receipt = yield* receipts.getByCommandId(receiptId);
        expect(Option.isSome(receipt)).toBe(true);
        const queued = yield* threads.sendToThread({
          projectId,
          threadId,
          commandId: CommandId.make("queued-typed"),
          messageId: MessageId.make("queued-typed"),
          text: "Queued typed work",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        expect(queued.delivery).toBe("queued");
        yield* store.apply({
          id: EventId.make("event:accepted-ended"),
          type: "run.updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...accepted.run, status: "completed" },
        });
        const staleVoice = { ...firstVoice, itemId: "stale-human", sequence: 2 };
        const speech = yield* recordVoiceMessage({
          projectId,
          threadId,
          role: "user",
          text: "Use my earlier selection",
          voice: staleVoice,
          creationSource: "web",
        });
        const beforeSpeech = yield* store.getThreadRecords(threadId, ["messages", "turnItems"], {
          messageIds: [speech.messageId],
        });
        holdTyped = true;
        const typed = yield* threads
          .sendToThread({
            projectId,
            threadId,
            commandId: CommandId.make("racing-typed"),
            messageId: MessageId.make("racing-typed"),
            text: "Newer typed request",
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(typedEntered);
        observePreflight = true;
        const stale = yield* sendLiveDelegation({
          ...acceptedInput,
          delegationId: "stale",
          userTurnId: staleVoice.itemId,
          userTranscript: "Use my earlier selection",
          expectedUserMessageCount: 1,
        }).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(stalePreflight);
        yield* Deferred.succeed(releaseTyped, undefined);
        const typedResult = yield* Fiber.join(typed);
        expect(typedResult.delivery).toBe("queued");
        const result = yield* Fiber.join(stale);
        const after = yield* store.getThreadRecords(threadId, [
          "messages",
          "turnItems",
          "runs",
          "providerTurns",
        ]);
        expect(after.runs.map((run) => [run.id, run.status])).toEqual([
          [accepted.run.id, "completed"],
          [queued.run.id, "starting"],
          [typedResult.run.id, "queued"],
        ]);
        expect(after.messages.map((message) => message.id).toSorted()).toEqual(
          [
            accepted.message.id,
            queued.message.id,
            speech.messageId,
            typedResult.message.id,
          ].toSorted(),
        );
        expect(after.providerTurns).toEqual([]);
        expect(after.messages.find((message) => message.id === speech.messageId)).toEqual(
          beforeSpeech.messages[0],
        );
        const recordedItem = beforeSpeech.turnItems.find(
          (item) => item.type === "user_message" && item.messageId === speech.messageId,
        )!;
        expect(after.turnItems.find((item) => item.id === recordedItem.id)).toEqual(recordedItem);
        expect(recordedItem.runId).toBe(null);
        expect(
          (yield* receipts.getByCommandId(CommandId.make("live_execute_admission_stale")))._tag,
        ).toBe("None");
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure._tag).toBe("OrchestratorInputChangedError");
        // Receipt replay precedes stale admission guards, even through the Live -> thread service path.
        expect((yield* sendLiveDelegation(acceptedInput)).run.id).toBe(accepted.run.id);
        expect(yield* receipts.getByCommandId(receiptId)).toEqual(receipt);
        expect(
          yield* store.getThreadRecords(threadId, [
            "messages",
            "turnItems",
            "runs",
            "providerTurns",
          ]),
        ).toEqual(after);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "stale Live model selection refuses without changing speech or queued work; accepted receipts replay",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:live-model-admission");
      yield* create(threadId);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const original = (yield* store.getThreadShell(threadId))!.modelSelection;
      const firstVoice = { ...voice, sessionId: "model-admission", itemId: "accepted-human" };
      yield* recordVoiceMessage({
        projectId,
        threadId,
        role: "user",
        text: "Inspect the fixture",
        voice: firstVoice,
        creationSource: "web",
      });
      const acceptedInput = {
        projectId,
        threadId,
        sessionId: firstVoice.sessionId,
        delegationId: "accepted",
        userTurnId: firstVoice.itemId,
        userTranscript: "Inspect the fixture",
        expectedUserMessageCount: 0,
        expectedModelSelection: original,
      };
      const accepted = yield* sendLiveDelegation(acceptedInput);
      const receiptId = CommandId.make("live_execute_model-admission_accepted");
      const receipt = yield* receipts.getByCommandId(receiptId);
      expect(Option.isSome(receipt)).toBe(true);
      const queued = yield* threads.sendToThread({
        projectId,
        threadId,
        commandId: CommandId.make("model-queued-typed"),
        messageId: MessageId.make("model-queued-typed"),
        text: "Queued typed work",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      expect(queued.delivery).toBe("queued");
      // Leave queued work eligible for promotion, so refusal must precede that mutation.
      yield* store.apply({
        id: EventId.make("event:model-accepted-ended"),
        type: "run.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: { ...accepted.run, status: "completed" },
      });
      const staleVoice = { ...firstVoice, itemId: "stale-human", sequence: 2 };
      const speech = yield* recordVoiceMessage({
        projectId,
        threadId,
        role: "user",
        text: "Use my earlier selection",
        voice: staleVoice,
        creationSource: "web",
      });
      const switched = { ...original, model: "gpt-6" };
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-admission-switch"),
        threadId,
        modelSelection: switched,
      });
      const beforeShell = yield* store.getThreadShell(threadId);
      expect(beforeShell!.modelSelection).toEqual(switched);
      const fields = ["messages", "turnItems", "runs", "providerTurns"] as const;
      const before = yield* store.getThreadRecords(threadId, fields);
      expect(before.messages.filter((message) => !message.voice)).toHaveLength(1);
      expect(before.runs.map((run) => [run.id, run.status])).toEqual([
        [accepted.run.id, "completed"],
        [queued.run.id, "queued"],
      ]);
      expect(before.messages.find((message) => message.id === speech.messageId)!.runId).toBe(null);
      const speechItem = before.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === speech.messageId,
      )!;
      expect(speechItem.runId).toBe(null);
      expect(before.providerTurns).toEqual([]);
      const result = yield* sendLiveDelegation({
        ...acceptedInput,
        delegationId: "stale",
        userTurnId: staleVoice.itemId,
        userTranscript: "Use my earlier selection",
        expectedUserMessageCount: 1,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure._tag).toBe("OrchestratorInputChangedError");
      expect(
        (yield* receipts.getByCommandId(CommandId.make("live_execute_model-admission_stale")))._tag,
      ).toBe("None");
      expect(yield* store.getThreadRecords(threadId, fields)).toEqual(before);
      expect(yield* store.getThreadShell(threadId)).toEqual(beforeShell);
      // The accepted command replays despite both its count and selection now being stale.
      const replay = yield* sendLiveDelegation(acceptedInput);
      expect(replay.run.id).toBe(accepted.run.id);
      expect(replay.message.id).toBe(accepted.message.id);
      expect(yield* receipts.getByCommandId(receiptId)).toEqual(receipt);
      expect(yield* store.getThreadRecords(threadId, fields)).toEqual(before);
      expect(yield* store.getThreadShell(threadId)).toEqual(beforeShell);
    }).pipe(Effect.provide(makeLayer())),
);
