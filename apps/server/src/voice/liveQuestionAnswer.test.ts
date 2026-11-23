import { expect, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type LiveVoiceServerEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Fixture from "../orchestration-v2/VoiceConversation.testkit.ts";
import { makeLiveAgentSession } from "./liveAgentSession.ts";

it.live.each([
  "answer",
  "idless",
  "changed",
  "closed",
  "approval",
  "partial",
  "mute",
  "stop",
  "no-custom",
] as const)("routes only the finalized answer for its original question: %s", (mode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make(`voice-question-${mode}`);
      yield* Fixture.create(threadId);
      const threads = yield* ThreadManagement.ThreadManagementService;
      const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
      const target = {
        requestId: RuntimeRequestId.make("question"),
        questionId: "color",
        nonce: "original",
      };
      const request: OrchestrationV2RuntimeRequest = {
        id: target.requestId,
        nodeId: NodeId.make("question-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: mode === "approval" ? "command" : "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      };
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make("question-item"),
        threadId,
        runId: null,
        nodeId: request.nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_input_request",
        requestId: request.id,
        questions: [
          {
            id: "color",
            header: "Color",
            question: "Which color?",
            options: [],
            allowCustomAnswer: mode !== "no-custom",
          },
        ],
      };
      let open = true;
      const events: LiveVoiceServerEvent[] = [];
      const agent = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "voice-question",
        onBound: () => {},
        send: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        append: () => Effect.void,
      }).pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ...threads,
          getThreadRecords: (...args) =>
            threads.getThreadRecords(...args).pipe(
              Effect.map((records) => ({
                ...records,
                runtimeRequests: open ? [request] : [],
                turnItems: [item],
              })),
            ),
        }),
      );
      yield* agent.setQuestionTarget(target);
      if (mode !== "idless")
        yield* agent.receive({ type: "turn_created", role: "user", turnId: "answer", text: "" });
      if (mode === "changed") yield* agent.setQuestionTarget({ ...target, nonce: "edited" });
      if (mode === "closed") open = false;
      if (mode === "mute") yield* agent.setMuted(true);
      if (mode === "stop") yield* agent.stop;
      if (mode !== "idless")
        yield* agent.receive({ type: "turn_delta", turnId: "answer", text: "Deep blue" });
      expect(events.filter((event) => event.type === "live.question.answer")).toHaveLength(0);
      if (mode !== "partial") {
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          ...(mode === "idless" ? {} : { turnId: "answer" }),
          text: "Deep blue",
        });
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          ...(mode === "idless" ? {} : { turnId: "answer" }),
          text: "Deep blue",
        });
      }
      const answers = events.filter((event) => event.type === "live.question.answer");
      expect(answers).toEqual(
        mode === "answer" || mode === "mute" || mode === "idless"
          ? [
              {
                type: "live.question.answer",
                sessionId: "voice-question",
                target,
                text: "Deep blue",
              },
            ]
          : [],
      );
      open = false;
      yield* agent.receive({
        type: "delegation",
        delegationId: CommandId.make("late-delegation"),
        userTurnId: "answer",
        instructions: "Use deep blue",
        provenance: "native_live_delegation",
      });
      const records = yield* threads.getThreadRecords(threadId, ["runs"]);
      expect(records.runs).toHaveLength(0);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Fixture.layer,
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/fixture/projects",
        }),
      ),
    ),
  ),
);
