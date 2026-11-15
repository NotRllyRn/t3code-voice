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
const makeFixture = Effect.fn("voice.test.agentFixture")(function* (
  binding: VoiceBinding = { threadId },
  initialRuns: OrchestrationV2Run[] = [],
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
                delivery: "started",
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
  return {
    bridge,
    fiber,
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
      f.set({
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("approval_1"),
            nodeId: NodeId.make("node_1"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        ],
      });
      yield* f.utterance("utterance_1", "yes approve that");
      yield* f.call();
      const status = yield* f.next(f.down, "agent.status");
      expect(status.status).toBe("waiting_for_user_in_T3");
      expect(f.sent).toHaveLength(0);
      expect(f.launched).toHaveLength(0);
    }),
  ).pipe(Effect.timeout("3 seconds")),
);

it.live(
  "only actual terminal T3 assistant text is fed back; accepted does not pretend to finish",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.utterance();
        yield* f.call();
        yield* f.next(f.down, "agent.status");
        expect(JSON.stringify(f.upstream)).not.toContain("actualAgentResult");
        f.set({
          runs: [{ ...run, status: "completed" }],
          messages: [{ ...message, role: "assistant", text: "Actual test run: 12 passed." }],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.next(f.down, "agent.status");
        // Drain response serially: notices cannot race a live response or trigger another coding call.
        for (let i = 0; i < 5 && !JSON.stringify(f.upstream).includes("actualAgentResult"); i++) {
          yield* f.bridge.receive({
            type: "response.done",
            response: { id: i === 0 ? "response_utterance_1" : `notice_${i - 1}` },
          });
          if (i === 0)
            yield* f.bridge.receive({ type: "relay.playback.done", response_id: "stale_response" });
          yield* f.bridge.receive({
            type: "relay.playback.done",
            response_id: i === 0 ? "response_utterance_1" : `notice_${i - 1}`,
          });
          const created = yield* f.next(f.up, "response.create");
          const response = created.response as {
            metadata: { voice_turn: string };
            tool_choice: string;
          };
          expect(response.tool_choice).toBe("none");
          yield* f.bridge.receive({
            type: "response.created",
            response: { id: `notice_${i}`, metadata: response.metadata },
          });
        }
        expect(JSON.stringify(f.upstream)).toContain("Actual test run: 12 passed.");
        expect(f.sent).toHaveLength(1);
      }),
    ).pipe(Effect.timeout("3 seconds")),
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
      const notice = yield* f.next(f.up, "response.create");
      yield* f.bridge.receive({
        type: "response.created",
        response: {
          id: "completion_notice",
          metadata: (notice.response as { metadata: object }).metadata,
        },
      });
      yield* f.bridge.receive({ type: "response.done", response: { id: "completion_notice" } });
      yield* f.bridge.receive({ type: "relay.playback.done", response_id: "completion_notice" });
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
        for (let i = 0; i < 6; i++) {
          const notice = yield* f.next(f.up, "response.create");
          const id = `notice_${i}`;
          yield* f.bridge.receive({
            type: "response.created",
            response: {
              id,
              metadata: (notice.response as { metadata: object }).metadata,
            },
          });
          yield* f.bridge.receive({ type: "response.done", response: { id } });
          yield* f.bridge.receive({ type: "relay.playback.done", response_id: id });
        }
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
