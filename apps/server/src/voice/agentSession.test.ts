import { expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { makeVoiceAgentSession, type VoiceBinding } from "./agentSession.ts";

const threadId = ThreadId.make("voice_owner");
const shell = liveThreadShell(threadId, { runtimeMode: "approval-required" });
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const run: OrchestrationV2Run = {
  id: RunId.make("run_voice"),
  threadId,
  ordinal: 1,
  providerInstanceId: shell.providerInstanceId,
  modelSelection: shell.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message_user"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const message: OrchestrationV2ConversationMessage = {
  id: MessageId.make("message_user"),
  threadId,
  runId: run.id,
  nodeId: null,
  role: "user",
  text: "",
  attachments: [],
  streaming: false,
  createdAt: now,
  updatedAt: now,
  createdBy: "user",
  creationSource: "web",
};
const permission: OrchestrationV2RuntimeRequest = {
  id: RuntimeRequestId.make("approval_1"),
  nodeId: NodeId.make("node_1"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: now,
  resolvedAt: null,
};
const makeFixture = Effect.fn("voice.test.agentFixture")(function* (
  binding: VoiceBinding = { threadId },
  initialRuns: OrchestrationV2Run[] = [],
  delivery: "started" | "queued" = "started",
) {
  let projection = { ...idleThreadProjection(shell), runs: initialRuns };
  const messageQueries: RunId[][] = [];
  const sent: ThreadManagement.ThreadManagementSendInput[] = [];
  const launched: ThreadLaunch.ThreadLaunchInput[] = [];
  let scratch = 0;
  let watchesClosed = 0;
  const up = yield* Queue.unbounded<Record<string, unknown>>();
  const down = yield* Queue.unbounded<Record<string, unknown>>();
  const upstream: object[] = [];
  const bridge = yield* makeVoiceAgentSession(
    binding,
    (event) =>
      Effect.gen(function* () {
        upstream.push(event);
        yield* Queue.offer(up, event as Record<string, unknown>);
      }),
    (event) => Queue.offer(down, event as Record<string, unknown>).pipe(Effect.asVoid),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          getThreadEventSequence: () => Effect.succeed(7),
          streamStoredEventsFrom: () =>
            Stream.never.pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  watchesClosed++;
                }),
              ),
            ),
          getThreadRecords: (_id, _include, query) =>
            Effect.sync(() => {
              if (query?.messageRunIds) messageQueries.push([...query.messageRunIds]);
              return {
                ...projection,
                messages: projection.messages.filter(
                  (message) =>
                    !query?.messageRunIds ||
                    (message.runId && query.messageRunIds.includes(message.runId)),
                ),
              };
            }),
          sendToThread: (input) =>
            Effect.sync(() => {
              sent.push(input);
              const createdMessage = { ...message, id: input.messageId, text: input.text };
              projection = { ...projection, runs: [run], messages: [createdMessage] };
              return {
                dispatch: { sequence: 8, storedEvents: [] },
                projection,
                message: createdMessage,
                run,
                turnItem: null,
                delivery,
              };
            }),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launched.push(input);
              projection = { ...projection, runs: [run] };
              return { threadId, projection, resumed: false };
            }),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/fictional/projects",
          ensureScratchProject: Effect.sync(() => {
            scratch++;
            return { projectId: ProjectId.make("scratch_managed") };
          }),
        }),
      ),
    ),
  );
  const next = (queue: typeof up, type: string): Effect.Effect<Record<string, unknown>> =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(queue);
        if (event.type === type) return event;
      }
    });
  const fiber = yield* bridge.run.pipe(Effect.forkScoped);
  if ("threadId" in binding) yield* next(down, "agent.bound");
  const utterance = Effect.fn("voice.test.utterance")(function* (
    id = "utterance_1",
    text = "Make the tests pass",
  ) {
    yield* bridge.receive({ type: "input_audio_buffer.speech_started", item_id: id });
    yield* bridge.receive({ type: "input_audio_buffer.speech_stopped", item_id: id });
    yield* bridge.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: id,
      transcript: text,
    });
    yield* next(up, "response.create");
    yield* bridge.receive({
      type: "response.created",
      response: { id: `response_${id}`, metadata: { voice_turn: id } },
    });
  });
  const call = (callId = "call_1", args = "{}", responseId = "response_utterance_1") =>
    bridge.receive({
      type: "response.function_call_arguments.done",
      response_id: responseId,
      name: "run_t3_agent",
      call_id: callId,
      arguments: args,
    });
  let barrier = 0;
  const flush = Effect.fn("voice.test.flushAgentEvents")(function* () {
    // A tool output with no associated utterance marks the end of earlier queued events.
    yield* call(`barrier_${++barrier}`, "{}", "unbound_response");
    while ((yield* next(down, "agent.status")).status !== "not_submitted") {}
  });
  const finish = Effect.fn("voice.test.finishResponse")(function* (id: string) {
    yield* bridge.receive({ type: "response.done", response: { id, status: "completed" } });
    yield* bridge.receive({ type: "relay.playback.done", response_id: id });
  });
  return {
    bridge,
    fiber,
    flush,
    finish,
    utterance,
    call,
    next,
    up,
    down,
    sent,
    launched,
    upstream,
    messageQueries,
    set: (update: Partial<typeof projection>) => {
      projection = { ...projection, ...update };
    },
    scratch: () => scratch,
    watchesClosed: () => watchesClosed,
  };
});

it.live(
  "VAD finalized function hands off once through the selected T3 thread; partials and replay cannot execute",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.bridge.receive({
          type: "conversation.item.input_audio_transcription.delta",
          item_id: "utterance_1",
          delta: "partial",
        });
        yield* f.utterance();
        expect(f.sent).toHaveLength(0);
        yield* f.call();
        yield* f.next(f.up, "conversation.item.create");
        yield* f.next(f.down, "agent.status");
        expect(f.sent).toHaveLength(1);
        expect(f.sent[0]).toMatchObject({
          threadId,
          text: "Make the tests pass",
          mode: "queue",
          attachments: [],
        });
        expect(f.sent[0]).not.toHaveProperty("runtimeMode");
        yield* f.call("call_2");
        const duplicate = yield* f.next(f.up, "conversation.item.create");
        expect(JSON.stringify(duplicate)).toContain("not_submitted");
        expect(f.sent).toHaveLength(1);
        yield* Fiber.interrupt(f.fiber);
        expect(f.watchesClosed()).toBe(1);
      }),
    ).pipe(Effect.timeout("3 seconds")),
);

it.live(
  "empty draft lazily launches managed Scratch using normal model, modes and initial message, never arbitrary cwd",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({
          draft: {
            modelSelection: shell.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
        });
        expect(f.scratch()).toBe(0);
        expect(f.launched).toHaveLength(0);
        yield* f.utterance();
        yield* f.call();
        yield* f.next(f.down, "agent.bound");
        expect(f.scratch()).toBe(1);
        expect(f.launched).toHaveLength(1);
        expect(f.sent).toHaveLength(0);
        expect(f.launched[0]).toMatchObject({
          projectId: "scratch_managed",
          modelSelection: shell.modelSelection,
          runtimeMode: "approval-required",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Make the tests pass" },
        });
      }),
    ).pipe(Effect.timeout("3 seconds")),
);

it.live("existing permission ownership cannot be granted or answered by a spoken yes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.set({ runtimeRequests: [permission] });
      yield* f.utterance("utterance_1", "yes approve that");
      yield* f.call();
      const status = yield* f.next(f.down, "agent.status");
      expect(status.status).toBe("waiting_for_user_in_T3");
      expect(f.sent).toHaveLength(0);
      expect(f.launched).toHaveLength(0);
      yield* f.bridge.receive({
        type: "response.done",
        response: { id: "response_utterance_1", status: "completed" },
      });
      yield* f.bridge.receive({ type: "relay.playback.done", response_id: "response_utterance_1" });
      const notice = yield* f.next(f.up, "response.create");
      expect(notice.response).toMatchObject({ output_modalities: ["audio"], tool_choice: "none" });
      yield* f.bridge.receive({
        type: "response.created",
        response: {
          id: "permission_notice",
          metadata: (notice.response as { metadata: object }).metadata,
        },
      });
      for (let i = 0; i < 20; i++)
        yield* f.bridge.receive({
          type: "agent.event",
          event: { type: "runtime-request.updated" },
        });
      yield* f.bridge.receive({ type: "response.done", response: { id: "permission_notice" } });
      yield* f.bridge.receive({ type: "relay.playback.done", response_id: "permission_notice" });
      yield* f.utterance("next_utterance", "What is blocking this?");
      const creates = f.upstream.filter(
        (event) => "type" in event && event.type === "response.create",
      );
      expect(creates).toHaveLength(3);
      expect(creates[2]).toMatchObject({ response: { output_modalities: ["text"] } });
    }),
  ).pipe(Effect.timeout("3 seconds")),
);

it.live(
  "resolved permission notices are dropped before speech, leaving only the actual result",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ threadId }, [run]);
        f.set({ runtimeRequests: [permission] });
        yield* f.utterance("utterance_1", "What is happening?");
        yield* f.call();
        yield* f.next(f.down, "agent.status");
        f.set({
          runtimeRequests: [],
          runs: [{ ...run, status: "completed" }],
          messages: [
            { ...message, role: "assistant", text: "The checks passed.", streaming: false },
          ],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.next(f.down, "agent.status");
        yield* f.bridge.receive({
          type: "response.done",
          response: { id: "response_utterance_1", status: "completed" },
        });
        yield* f.bridge.receive({
          type: "relay.playback.done",
          response_id: "response_utterance_1",
        });
        const result = yield* f.next(f.up, "response.create");
        expect(result.response).toMatchObject({
          output_modalities: ["audio"],
          tool_choice: "none",
        });
        const messages = f.upstream.filter(
          (event) => "item" in event && (event.item as { type: string }).type === "message",
        );
        expect(JSON.stringify(messages)).toContain("The checks passed.");
        expect(JSON.stringify(messages)).not.toContain("voice cannot approve");
        expect(
          f.upstream.filter((event) => "type" in event && event.type === "response.create"),
        ).toHaveLength(2);
        expect(f.sent).toHaveLength(0);
      }),
    ),
);

it.live(
  "conversational utterances get one audible reply after silent routing, not repeated acknowledgements",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.utterance("hello", "Hello");
        yield* f.bridge.receive({
          type: "response.done",
          response: { id: "response_hello", status: "completed" },
        });
        yield* f.bridge.receive({ type: "relay.playback.done", response_id: "response_hello" });
        const reply = yield* f.next(f.up, "response.create");
        expect(reply.response).toMatchObject({ output_modalities: ["audio"], tool_choice: "none" });
        expect(JSON.stringify(f.upstream)).toContain("replyToUtterance");
        yield* f.bridge.receive({
          type: "response.done",
          response: { id: "response_hello", status: "completed" },
        });
        yield* f.bridge.receive({
          type: "response.created",
          response: {
            id: "hello_reply",
            metadata: (reply.response as { metadata: object }).metadata,
          },
        });
        yield* f.bridge.receive({
          type: "response.done",
          response: { id: "hello_reply", status: "completed" },
        });
        yield* f.bridge.receive({ type: "relay.playback.done", response_id: "hello_reply" });
        yield* f.utterance("next_utterance", "Thank you");
        const creates = f.upstream.filter(
          (event) => "type" in event && event.type === "response.create",
        );
        expect(creates).toHaveLength(3);
        expect(creates[2]).toMatchObject({ response: { output_modalities: ["text"] } });
        expect(f.sent).toHaveLength(0);
      }),
    ),
);

it.live.each(["started", "queued"] as const)(
  "a short result after a status storm speaks once, without acceptance or completion announcements (delivery: %s)",
  (delivery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ threadId }, [], delivery);
        yield* f.utterance();
        yield* f.call();
        yield* f.next(f.down, "agent.status");
        expect(JSON.stringify(f.upstream)).not.toContain("actualAgentResult");
        yield* f.next(f.down, "agent.status");
        const outputs = f.upstream.filter(
          (event) =>
            "item" in event && (event.item as { type: string }).type === "function_call_output",
        );
        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({
          item: { call_id: "call_1", type: "function_call_output" },
        });
        expect(JSON.parse((outputs[0] as { item: { output: string } }).item.output)).toMatchObject({
          status: delivery,
          runId: run.id,
        });
        expect(
          f.upstream.find((event) => "type" in event && event.type === "response.create"),
        ).toMatchObject({ response: { output_modalities: ["text"] } });
        const statusCycle = ["starting", "running", "waiting", "running"] as const;
        for (let i = 0; i < 20; i++) {
          const current = statusCycle[i % statusCycle.length]!;
          f.set({ runs: [{ ...run, status: current }] });
          yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
          const status = yield* f.next(f.down, "agent.status");
          expect(status.status).toBe(current);
        }
        f.set({
          runs: [{ ...run, status: "completed" }],
          messages: [{ ...message, role: "assistant", text: "Actual test run: 12 passed." }],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.next(f.down, "agent.status");
        yield* f.bridge.receive({
          type: "response.done",
          response: { id: "response_utterance_1", status: "completed" },
        });
        yield* f.bridge.receive({ type: "relay.playback.done", response_id: "stale_response" });
        yield* f.bridge.receive({
          type: "relay.playback.done",
          response_id: "response_utterance_1",
        });
        const created = yield* f.next(f.up, "response.create");
        expect(created.response).toMatchObject({
          output_modalities: ["audio"],
          tool_choice: "none",
        });
        expect(JSON.stringify(f.upstream)).toContain("Actual test run: 12 passed.");
        const creates = () =>
          f.upstream.filter((event) => "type" in event && event.type === "response.create");
        expect(creates()).toHaveLength(2);
        expect(creates()[0]).toMatchObject({ response: { output_modalities: ["text"] } });
        yield* f.bridge.receive({
          type: "response.created",
          response: {
            id: "final_result",
            metadata: (created.response as { metadata: object }).metadata,
          },
        });
        yield* f.bridge.receive({ type: "response.done", response: { id: "final_result" } });
        yield* f.bridge.receive({ type: "relay.playback.done", response_id: "final_result" });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        yield* f.utterance("utterance_2", "What is the current progress?");
        expect(creates()).toHaveLength(3);
        expect(creates()[2]).toMatchObject({ response: { output_modalities: ["text"] } });
        expect(JSON.stringify(f.upstream).split("Actual test run: 12 passed.")).toHaveLength(2);
        yield* f.call("progress_call", "{}", "response_utterance_2");
        yield* f.next(f.down, "agent.status");
        expect(f.sent).toHaveLength(2);
        expect(f.sent[1]?.text).toBe("What is the current progress?");
      }),
    ).pipe(Effect.timeout("3 seconds")),
);

it.live(
  "a failed run without assistant text speaks once and still delivers a late actual result",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ threadId }, [run]);
        f.set({
          runs: [{ ...run, status: "failed" }],
          messages: [{ ...message, text: "RAW_ERROR_SECRET_MUST_NOT_BE_SPOKEN" }],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.flush();
        const creates = () =>
          f.upstream.filter((event) => "type" in event && event.type === "response.create");
        expect(creates()).toHaveLength(1);
        expect(creates()[0]).toMatchObject({
          response: { output_modalities: ["audio"], tool_choice: "none" },
        });
        expect(JSON.stringify(f.upstream)).toContain(
          "The coding run failed. Check the normal T3 UI for details.",
        );
        expect(JSON.stringify(f.upstream)).not.toContain("RAW_ERROR_SECRET");
        yield* f.bridge.receive({ type: "response.created", response: { id: "failure_notice" } });
        for (let i = 0; i < 3; i++)
          yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.finish("failure_notice");
        yield* f.flush();
        expect(creates()).toHaveLength(1);
        f.set({
          messages: [{ ...message, role: "assistant", text: "LATE_ACTUAL_FAILURE_RESULT" }],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        yield* f.flush();
        expect(creates()).toHaveLength(2);
        expect(JSON.stringify(f.upstream).split("LATE_ACTUAL_FAILURE_RESULT")).toHaveLength(2);
        yield* f.bridge.receive({ type: "response.created", response: { id: "late_result" } });
        yield* f.finish("late_result");
        for (let i = 0; i < 3; i++)
          yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        yield* f.flush();
        expect(creates()).toHaveLength(2);
        expect(f.sent).toHaveLength(0);
      }),
    ),
);

it.live.each([false, true])(
  "an actual failure result replaces a fallback before speech (final initially available: %s)",
  (initiallyAvailable) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.utterance();
        yield* f.call();
        yield* f.flush();
        const final = { ...message, role: "assistant" as const, text: "ACTUAL_FAILURE_RESULT" };
        f.set({
          runs: [{ ...run, status: "failed" }],
          messages: initiallyAvailable ? [final] : [],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.flush();
        if (!initiallyAvailable) {
          f.set({ messages: [final] });
          yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
          yield* f.flush();
        }
        yield* f.finish("response_utterance_1");
        yield* f.flush();
        const creates = () =>
          f.upstream.filter((event) => "type" in event && event.type === "response.create");
        expect(creates()).toHaveLength(2);
        expect(creates()[1]).toMatchObject({ response: { output_modalities: ["audio"] } });
        expect(JSON.stringify(f.upstream)).toContain("ACTUAL_FAILURE_RESULT");
        expect(JSON.stringify(f.upstream)).not.toContain("The coding run failed.");
        yield* f.bridge.receive({ type: "response.created", response: { id: "actual_result" } });
        yield* f.finish("actual_result");
        yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        yield* f.flush();
        expect(creates()).toHaveLength(2);
        expect(JSON.stringify(f.upstream).split("ACTUAL_FAILURE_RESULT")).toHaveLength(2);
        expect(f.sent).toHaveLength(1);
      }),
    ),
);

it.live("barge-in drops a queued failure notice without suppressing a later actual result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.utterance();
      yield* f.call();
      yield* f.flush();
      f.set({ runs: [{ ...run, status: "failed" }] });
      yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
      yield* f.flush();
      yield* f.bridge.receive({ type: "input_audio_buffer.speech_started" });
      yield* f.finish("response_utterance_1");
      yield* f.bridge.receive({ type: "input_audio_buffer.speech_stopped" });
      yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
      yield* f.flush();
      const creates = () =>
        f.upstream.filter((event) => "type" in event && event.type === "response.create");
      expect(creates()).toHaveLength(1);
      expect(JSON.stringify(f.upstream)).not.toContain("The coding run failed.");
      f.set({ messages: [{ ...message, role: "assistant", text: "POST_BARGE_IN_RESULT" }] });
      yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
      yield* f.flush();
      expect(creates()).toHaveLength(2);
      expect(JSON.stringify(f.upstream)).toContain("POST_BARGE_IN_RESULT");
      expect(f.sent).toHaveLength(1);
    }),
  ),
);

it.live("binding during a run delivers its late final text, not historical terminal results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const historical = {
        ...run,
        id: RunId.make("historical"),
        ordinal: 0,
        status: "completed" as const,
      };
      const f = yield* makeFixture({ threadId }, [historical, run]);
      f.set({ runs: [historical, { ...run, status: "completed" }] });
      yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
      const status = yield* f.next(f.down, "agent.status");
      expect(status).toMatchObject({ run_id: run.id, status: "completed" });
      expect(f.upstream.some((event) => "type" in event && event.type === "response.create")).toBe(
        false,
      );
      f.set({
        messages: [
          { ...message, role: "assistant", text: "REAL_RESULT_1" },
          {
            ...message,
            id: MessageId.make("old_message"),
            runId: historical.id,
            role: "assistant",
            text: "HISTORICAL_RESULT",
          },
        ],
      });
      yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
      yield* f.next(f.up, "response.create");
      expect(JSON.stringify(f.upstream)).toContain("REAL_RESULT_1");
      expect(JSON.stringify(f.upstream)).not.toContain("HISTORICAL_RESULT");
      expect(f.sent).toHaveLength(0);
    }),
  ),
);

it.live.each([false, true])(
  "four newer queued runs cannot hide the oldest result (observed running: %s)",
  (observedRunning) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ threadId }, observedRunning ? [run] : []);
        const queued = Array.from({ length: 4 }, (_, i) => ({
          ...run,
          id: RunId.make(`queued_${i}`),
          ordinal: i + 2,
          status: "queued" as const,
        }));
        f.set({
          runs: [{ ...run, status: "completed" }, ...queued],
          messages: [{ ...message, role: "assistant", text: "OLDEST_REAL_RESULT" }],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        const notice = yield* f.next(f.up, "response.create");
        expect(notice.response).toMatchObject({
          output_modalities: ["audio"],
          tool_choice: "none",
        });
        expect(JSON.stringify(f.upstream)).toContain("OLDEST_REAL_RESULT");
        expect(f.messageQueries.some((ids) => ids.includes(run.id))).toBe(true);
        expect(f.messageQueries.every((ids) => ids.length <= 4)).toBe(true);
        expect(f.sent).toHaveLength(0);
      }),
    ),
);

it.live.each(['{"threadId":"other"}', '{"command":"rm -rf x"}', "null", "[]"])(
  "rejects unsupported voice arguments %s before any dispatch",
  (args) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.utterance();
        yield* f.call("call_1", args);
        expect((yield* Fiber.join(f.fiber).pipe(Effect.result))._tag).toBe("Failure");
        expect(f.sent).toHaveLength(0);
      }),
    ).pipe(Effect.timeout("3 seconds")),
);

it.live("barge-in during silent routing cannot queue a stale conversational reply", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.utterance("hello", "Hello");
      yield* f.bridge.receive({ type: "input_audio_buffer.speech_started", item_id: "next" });
      yield* f.bridge.receive({
        type: "response.done",
        response: { id: "response_hello", status: "completed" },
      });
      yield* f.bridge.receive({ type: "relay.playback.done", response_id: "response_hello" });
      yield* f.utterance("next", "Actually, run the tests");
      const creates = f.upstream.filter(
        (event) => "type" in event && event.type === "response.create",
      );
      expect(creates).toHaveLength(2);
      expect(creates[1]).toMatchObject({ response: { output_modalities: ["text"] } });
      expect(JSON.stringify(f.upstream)).not.toContain("replyToUtterance");
      expect(f.sent).toHaveLength(0);
    }),
  ),
);

it.live(
  "barge-in cancels only not-yet-dispatched voice functions; late completed audio never repeats work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.utterance();
        yield* f.bridge.receive({
          type: "input_audio_buffer.speech_started",
          item_id: "utterance_2",
        });
        yield* f.call();
        yield* f.next(f.down, "agent.status");
        expect(f.sent).toHaveLength(0);
        yield* Fiber.interrupt(f.fiber);
        yield* f.call("late_call");
        expect(f.sent).toHaveLength(0);
      }),
    ).pipe(Effect.timeout("3 seconds")),
);
