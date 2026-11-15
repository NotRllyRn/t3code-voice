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
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
const assistantItem = (
  id: string,
  phase: "commentary" | "final_answer",
): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`item_${id}`),
  threadId,
  runId: run.id,
  nodeId: null,
  ordinal: 1,
  type: "assistant_message",
  status: "completed",
  startedAt: now,
  completedAt: now,
  messageId: MessageId.make(id),
  phase,
  text: "",
  textOmitted: true,
  streaming: false,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  title: null,
  updatedAt: now,
});
const feedbackData = (events: object[]) =>
  events.flatMap((event) => {
    if (!("item" in event)) return [];
    const item = event.item as { content?: Array<{ text: string }> };
    const text = item.content?.[0]?.text;
    return text?.startsWith("T3 conversation data")
      ? [JSON.parse(text.slice(text.indexOf("\n") + 1)) as Record<string, unknown>]
      : [];
  });
const makeFixture = Effect.fn("voice.test.agentFixture")(function* (
  binding: VoiceBinding = { threadId },
  initialRuns: OrchestrationV2Run[] = [],
  delivery: "started" | "queued" = "started",
  initialMessages: OrchestrationV2ConversationMessage[] = [],
) {
  let projection = { ...idleThreadProjection(shell), runs: initialRuns, messages: initialMessages };
  const messageQueries: RunId[][] = [];
  const sent: ThreadManagement.ThreadManagementSendInput[] = [];
  const launched: ThreadLaunch.ThreadLaunchInput[] = [];
  const recorded: OrchestrationV2ConversationMessage[] = [];
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
          getTimelinePage: () =>
            Effect.succeed({ items: [], totalItems: 0, hasMore: false, hasEarlier: false }),
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
          getProjectThreadRecords: (_input, _include, query) =>
            Effect.sync(() => ({
              ...projection,
              messages: recorded.filter(
                (entry) => !query?.messageIds || query.messageIds.includes(entry.id),
              ),
            })),
          dispatch: (input) =>
            Effect.sync(() => {
              if (input.type !== "voice.message.record") throw Error("Unexpected command");
              const entry = {
                ...message,
                id: input.messageId,
                runId: null,
                role: input.role,
                text: input.text,
                voice: input.voice,
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              };
              const index = recorded.findIndex((old) => old.id === entry.id);
              if (index < 0) recorded.push(entry);
              else recorded[index] = entry;
              return { sequence: 8, storedEvents: [] };
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
    yield* bridge.receive({ type: "input_audio_buffer.committed", item_id: id });
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
  const created = (id: string) =>
    bridge.receive({
      type: "response.created",
      response: {
        id,
        metadata: (
          upstream
            .filter((event) => "type" in event && event.type === "response.create")
            .at(-1) as { response: { metadata: object } }
        ).response.metadata,
      },
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
    created,
    utterance,
    call,
    next,
    up,
    down,
    sent,
    launched,
    recorded,
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
        yield* f.flush();
        const duplicate = f.upstream.find(
          (event) => "item" in event && (event.item as { call_id?: string }).call_id === "call_2",
        );
        expect(JSON.stringify(duplicate)).toContain("not_submitted");
        expect(f.sent).toHaveLength(1);
        yield* Fiber.interrupt(f.fiber);
        expect(f.watchesClosed()).toBe(1);
      }),
    ).pipe(Effect.timeout("3 seconds")),
);

it.live(
  "first draft final creates empty managed Scratch with selected model and modes, then records before execution",
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
        yield* f.next(f.down, "agent.bound");
        expect(f.recorded).toHaveLength(1);
        expect(f.sent).toHaveLength(0);
        yield* f.call();
        yield* f.next(f.down, "agent.status");
        expect(f.scratch()).toBe(1);
        expect(f.launched).toHaveLength(1);
        expect(f.sent).toHaveLength(1);
        expect(f.launched[0]).not.toHaveProperty("initialMessage");
        expect(f.launched[0]).toMatchObject({
          projectId: "scratch_managed",
          modelSelection: shell.modelSelection,
          runtimeMode: "approval-required",
          workspaceStrategy: { type: "root" },
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
      expect(f.recorded.map((entry) => entry.text)).toEqual(["yes approve that"]);
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

it.effect(
  "a typed question supplies its canonical request and the actual qualified answer, not voice echoes or commentary",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const question = { ...message, text: "Can I type here and have you reply aloud?" };
        f.set({
          runs: [{ ...run, status: "completed" }],
          messages: [
            question,
            {
              ...message,
              id: MessageId.make("commentary"),
              role: "assistant",
              text: "I will check the voice setup.",
            },
            {
              ...message,
              id: MessageId.make("answer"),
              role: "assistant",
              text:
                "Yes. Type here and I can reply aloud while voice is connected. " +
                "Useful detail. ".repeat(900) +
                "I cannot speak after voice disconnects.",
            },
            {
              ...message,
              id: MessageId.make("child"),
              role: "assistant",
              nodeId: NodeId.make("child_node"),
              text: "CHILD_RESULT_NOT_THE_MAIN_ANSWER",
            },
            {
              ...message,
              id: MessageId.make("echo"),
              role: "assistant",
              text: "Sure, all set now.",
              voice: {
                sessionId: "old",
                itemId: "old",
                sequence: 1,
                textKind: "generated_voice_reply",
                delivery: "drained",
              },
            },
          ],
          turnItems: [
            assistantItem("commentary", "commentary"),
            assistantItem("answer", "final_answer"),
            { ...assistantItem("child", "final_answer"), nodeId: NodeId.make("child_node") },
          ],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        const response = yield* f.next(f.up, "response.create");
        expect(response.response).toMatchObject({
          output_modalities: ["audio"],
          tool_choice: "none",
          instructions: expect.stringContaining("qualifications"),
        });
        const data = feedbackData(f.upstream);
        expect(data).toHaveLength(1);
        expect(data[0]).toMatchObject({
          actualAgentResult: expect.stringMatching(/^Yes\. Type here/),
          requests: [{ messageId: question.id, text: question.text }],
          sourceMessageIds: ["answer"],
        });
        expect(String(data[0]?.actualAgentResult)).toContain(
          "I cannot speak after voice disconnects.",
        );
        expect(JSON.stringify(data)).not.toContain("Sure, all set now.");
        expect(JSON.stringify(data)).not.toContain("I will check the voice setup.");
        expect(JSON.stringify(data)).not.toContain("CHILD_RESULT_NOT_THE_MAIN_ANSWER");
        expect(f.sent).toHaveLength(0);
        yield* f.created("voiced_final");
        yield* f.bridge.receive({
          type: "response.output_audio_transcript.done",
          response_id: "voiced_final",
          item_id: "answer_audio",
          content_index: 0,
          transcript: "Yes, while voice is connected.",
        });
        yield* f.finish("voiced_final");
        yield* f.flush();
        expect(f.recorded.find((entry) => entry.role === "assistant")?.voice).toMatchObject({
          sourceRunId: run.id,
          sourceMessageIds: ["answer"],
          delivery: "drained",
        });
        expect(feedbackData(f.upstream)).toHaveLength(1);
      }),
    ),
);

it.effect(
  "typed acceptance is context only, acknowledged once by canonical ID with no execution or status chatter",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const question = { ...message, text: "Can I type a question while voice is connected?" };
        f.set({ runs: [{ ...run, status: "queued" }], messages: [question] });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        const ack = yield* f.next(f.up, "response.create");
        expect(ack.response).toMatchObject({
          tool_choice: "none",
          instructions: expect.stringContaining("do not claim work has started"),
        });
        expect(JSON.stringify(f.upstream)).toContain("requestContext");
        expect(JSON.stringify(f.upstream)).toContain(question.text);
        yield* f.created("ack");
        yield* f.finish("ack");
        for (const status of ["queued", "running", "running"] as const) {
          f.set({ runs: [{ ...run, status }] });
          yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        }
        yield* f.flush();
        expect(feedbackData(f.upstream).filter((data) => data.acceptedRequest)).toHaveLength(1);
        expect(
          f.upstream.filter((event) => "type" in event && event.type === "response.create"),
        ).toHaveLength(1);
        expect(
          f.upstream.filter((event) => JSON.stringify(event).includes("requestContext")),
        ).toHaveLength(1);
        expect(f.sent).toHaveLength(0);
      }),
    ),
);

it.effect(
  "spoken acceptance and its written projection share one acknowledgement and saved source identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ threadId }, [], "queued");
        yield* f.utterance();
        yield* f.call();
        yield* f.finish("response_utterance_1");
        const ack = yield* f.next(f.up, "response.create");
        expect(ack.response).toMatchObject({
          tool_choice: "none",
          instructions: expect.stringContaining("Acceptance may be queued"),
        });
        yield* f.created("ack");
        yield* f.bridge.receive({
          type: "response.output_audio_transcript.done",
          response_id: "ack",
          item_id: "ack_item",
          content_index: 0,
          transcript: "Got it.",
        });
        yield* f.finish("ack");
        yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        yield* f.flush();
        expect(feedbackData(f.upstream).filter((data) => data.acceptedRequest)).toHaveLength(1);
        expect(f.sent).toHaveLength(1);
        const spoken = f.recorded.find((entry) => entry.role === "assistant");
        expect(spoken?.voice).toMatchObject({
          sourceRunId: run.id,
          sourceMessageIds: [f.sent[0]?.messageId],
          delivery: "drained",
        });
      }),
    ),
);

it.effect(
  "only completed authored commentary gives an occasional milestone, never tools, reasoning or repeated updates",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const question = { ...message, text: "Find why the typed and spoken answers differ." };
        f.set({ runs: [run], messages: [question] });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.next(f.up, "response.create");
        yield* f.created("ack");
        yield* f.finish("ack");
        yield* f.flush();
        yield* TestClock.adjust("21 seconds");
        const text =
          "I found that the result selector included earlier commentary. I am narrowing it to the final answer.";
        f.set({
          messages: [
            question,
            { ...message, id: MessageId.make("milestone"), role: "assistant", text },
          ],
          turnItems: [assistantItem("milestone", "commentary")],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "turn-item.updated" } });
        const progress = yield* f.next(f.up, "response.create");
        expect(progress.response).toMatchObject({
          instructions: expect.stringContaining("do not turn plans into completed actions"),
        });
        expect(feedbackData(f.upstream).at(-1)).toMatchObject({
          actualAgentCommentary: text,
          sourceMessageIds: ["milestone"],
        });
        yield* f.created("progress");
        yield* f.finish("progress");
        yield* TestClock.adjust("30 seconds");
        yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        yield* f.flush();
        expect(feedbackData(f.upstream).filter((data) => data.actualAgentCommentary)).toHaveLength(
          1,
        );
        expect(f.messageQueries.every((ids) => ids.length <= 4)).toBe(true);
        for (let index = 0; index < 4; index++) {
          yield* TestClock.adjust("21 seconds");
          const id = `more_${index}`;
          f.set({
            messages: [
              question,
              {
                ...message,
                id: MessageId.make(id),
                role: "assistant",
                text: `I found useful evidence ${index} in the authored message selector.`,
              },
            ],
            turnItems: [assistantItem(id, "commentary")],
          });
          yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
          yield* f.flush();
          if (index < 2) {
            yield* f.next(f.up, "response.create");
            yield* f.created(id);
            yield* f.finish(id);
          }
        }
        yield* f.flush();
        expect(feedbackData(f.upstream).filter((data) => data.actualAgentCommentary)).toHaveLength(
          3,
        );
      }),
    ),
);

it.effect(
  "canonical request order wins when a spoken submission beats its written projection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.utterance("voice_question", "What about offline use?");
        yield* f.call("call_1", "{}", "response_voice_question");
        yield* f.next(f.up, "conversation.item.create");
        const earlier = {
          ...message,
          id: MessageId.make("typed_first"),
          text: "Can I type and hear replies?",
        };
        const spoken = { ...message, id: f.sent[0]!.messageId, text: "What about offline use?" };
        f.set({
          runs: [{ ...run, status: "completed" }],
          messages: [
            earlier,
            spoken,
            {
              ...message,
              id: MessageId.make("ordered_final"),
              role: "assistant",
              text: "You can type and hear replies while connected; offline voice is not available.",
            },
          ],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.finish("response_voice_question");
        yield* f.next(f.up, "response.create");
        expect(feedbackData(f.upstream).at(-1)).toMatchObject({
          requests: [
            { messageId: earlier.id, text: earlier.text },
            { messageId: spoken.id, text: spoken.text },
          ],
        });
        expect(feedbackData(f.upstream).filter((data) => data.acceptedRequest)).toHaveLength(0);
        expect(f.sent).toHaveLength(1);
      }),
    ),
);

it.effect(
  "queued commentary is coalesced to its latest evidence; a final removes stale commentary and acknowledgement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const question = { ...message, text: "Explain the result selection bug." };
        f.set({ runs: [run], messages: [question] });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.next(f.up, "response.create");
        yield* f.created("ack"); // Hold audio so successive actual messages coalesce behind it.
        yield* f.flush();
        yield* TestClock.adjust("21 seconds");
        for (const id of ["old", "latest"]) {
          f.set({
            messages: [
              question,
              {
                ...message,
                id: MessageId.make(id),
                role: "assistant",
                text: `I found the ${id} evidence for the selection bug.`,
              },
            ],
            turnItems: [assistantItem(id, "commentary")],
          });
          yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        }
        yield* f.flush();
        yield* f.finish("ack");
        yield* f.next(f.up, "response.create");
        expect(feedbackData(f.upstream).filter((data) => data.actualAgentCommentary)).toEqual([
          expect.objectContaining({
            actualAgentCommentary: "I found the latest evidence for the selection bug.",
          }),
        ]);
        yield* f.created("progress");
        yield* TestClock.adjust("21 seconds");
        f.set({
          messages: [
            question,
            {
              ...message,
              id: MessageId.make("stale"),
              role: "assistant",
              text: "I have more evidence, but have not finished the fix.",
            },
          ],
          turnItems: [assistantItem("stale", "commentary")],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        yield* f.flush();
        f.set({
          runs: [{ ...run, status: "completed" }],
          messages: [
            question,
            {
              ...message,
              id: MessageId.make("final"),
              role: "assistant",
              text: "The selector read commentary as a result. It now selects the final answer.",
            },
          ],
          turnItems: [assistantItem("final", "final_answer")],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.finish("progress");
        yield* f.next(f.up, "response.create");
        yield* f.created("final");
        yield* f.finish("final");
        yield* f.bridge.receive({ type: "agent.event", event: { type: "message.updated" } });
        yield* f.flush();
        expect(feedbackData(f.upstream).filter((data) => data.actualAgentCommentary)).toHaveLength(
          1,
        );
        expect(feedbackData(f.upstream).filter((data) => data.actualAgentResult)).toHaveLength(1);
        expect(JSON.stringify(feedbackData(f.upstream))).not.toContain("have not finished the fix");
      }),
    ),
);

it.effect(
  "joining an active run preserves the accepted question without reacknowledging history; over-budget answers are not clipped",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const question = { ...message, text: "Does this work offline?" };
        const f = yield* makeFixture({ threadId }, [run], "started", [question]);
        f.set({
          runs: [{ ...run, status: "completed" }],
          messages: [
            question,
            {
              ...message,
              id: MessageId.make("long"),
              role: "assistant",
              text:
                "No, it needs a connection. " +
                "Context. ".repeat(13000) +
                "Only the local editor works offline.",
            },
          ],
        });
        yield* f.bridge.receive({ type: "agent.event", event: { type: "run.updated" } });
        yield* f.next(f.up, "response.create");
        expect(feedbackData(f.upstream)).toEqual([
          expect.objectContaining({ note: expect.stringContaining("too long for voice") }),
        ]);
        expect(JSON.stringify(f.upstream)).not.toContain("Only the local editor");
        expect(feedbackData(f.upstream).some((data) => data.acceptedRequest)).toBe(false);
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
        yield* f.created("failure_notice");
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
        yield* f.created("late_result");
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
        yield* f.created("actual_result");
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

it.live(
  "committed input order survives reversed finals; deltas and duplicate finals cannot dispatch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.bridge.receive({ type: "input_audio_buffer.committed", item_id: "first" });
        yield* f.bridge.receive({
          type: "input_audio_buffer.committed",
          item_id: "second",
          previous_item_id: "first",
        });
        yield* f.bridge.receive({
          type: "conversation.item.input_audio_transcription.delta",
          item_id: "first",
          delta: "partial",
        });
        yield* f.bridge.receive({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "second",
          transcript: "second final",
        });
        yield* f.flush();
        expect(f.recorded).toHaveLength(0);
        yield* f.bridge.receive({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "first",
          transcript: "first final",
        });
        yield* f.flush();
        expect(f.recorded.map((entry) => entry.text)).toEqual(["first final", "second final"]);
        expect(f.recorded[1]?.voice).toMatchObject({ predecessorItemId: "first", sequence: 1 });
        yield* f.bridge.receive({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "second",
          transcript: "second final",
        });
        yield* f.flush();
        expect(f.recorded).toHaveLength(2);
        expect(f.sent).toHaveLength(0);
      }),
    ).pipe(Effect.timeout("3 seconds")),
);

it.live(
  "greeting and generated reply are canonical without execution; next coding call reuses only its recorded message",
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
        yield* f.utterance("hello", "Hello");
        yield* f.finish("response_hello");
        yield* f.next(f.up, "response.create");
        yield* f.created("greeting_reply");
        yield* f.bridge.receive({
          type: "response.output_audio_transcript.done",
          response_id: "greeting_reply",
          item_id: "reply_item",
          content_index: 0,
          transcript: "Hello! What would you like to work on?",
        });
        yield* f.flush();
        expect(f.recorded.map((entry) => entry.role)).toEqual(["user", "assistant"]);
        expect(f.recorded[1]?.voice).toMatchObject({
          delivery: "pending",
          textKind: "generated_voice_reply",
          responseId: "greeting_reply",
        });
        expect(f.sent).toHaveLength(0);
        yield* f.finish("greeting_reply");
        yield* f.flush();
        expect(f.recorded[1]?.voice?.delivery).toBe("drained");
        yield* f.utterance("coding", "Now add the test");
        yield* f.flush();
        const saved = f.recorded.at(-1)!;
        expect(saved.text).toBe("Now add the test");
        yield* f.call("coding_call", "{}", "response_coding");
        yield* f.flush();
        yield* f.call("duplicate_call", "{}", "response_coding");
        yield* f.flush();
        expect(f.sent).toHaveLength(1);
        expect(f.sent[0]).toMatchObject({ messageId: saved.id, text: saved.text });
        expect(f.recorded).toHaveLength(3);
        expect(f.launched).toHaveLength(1);
        expect(f.launched[0]).not.toHaveProperty("initialMessage");
      }),
    ).pipe(Effect.timeout("3 seconds")),
);

it.live("spoken input is saved but cannot release a held queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* makeFixture({ threadId }, [{ ...run, status: "queued", queueHeld: true }]);
      yield* f.utterance("hold", "yes go ahead");
      yield* f.call("hold_call", "{}", "response_hold");
      const status = yield* f.next(f.down, "agent.status");
      expect(status.status).toBe("waiting_for_user_in_T3");
      expect(JSON.stringify(f.upstream)).toContain("held queue");
      expect(f.sent).toHaveLength(0);
      expect(f.recorded.map((entry) => entry.text)).toEqual(["yes go ahead"]);
    }),
  ).pipe(Effect.timeout("3 seconds")),
);

it.live.each(["interrupted", "unknown"] as const)(
  "full generated text is not heard text (%s receipt)",
  (delivery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.utterance("hello", "Hello");
        yield* f.finish("response_hello");
        yield* f.next(f.up, "response.create");
        yield* f.created("reply");
        yield* f.bridge.receive({
          type: "response.content_part.added",
          response_id: "reply",
          item_id: "reply_item",
          content_index: 0,
        });
        if (delivery === "interrupted") {
          yield* f.bridge.receive({ type: "input_audio_buffer.speech_started" });
          yield* f.bridge.receive({
            type: "conversation.item.truncate",
            item_id: "foreign",
            content_index: 0,
            audio_end_ms: 50,
          });
          yield* f.bridge.receive({
            type: "conversation.item.truncate",
            item_id: "reply_item",
            content_index: 0,
            audio_end_ms: 125,
          });
        }
        yield* f.bridge.receive({
          type: "response.audio_transcript.done",
          response_id: "reply",
          item_id: "reply_item",
          content_index: 0,
          transcript: "This entire sentence was generated, not necessarily heard.",
        });
        yield* f.flush();
        if (delivery === "interrupted") {
          yield* f.finish("reply");
          yield* f.flush();
        }
        yield* Fiber.interrupt(f.fiber);
        expect(f.recorded).toHaveLength(2);
        expect(f.recorded[1]?.text).toBe(
          "This entire sentence was generated, not necessarily heard.",
        );
        expect(f.recorded[1]?.voice).toMatchObject({ delivery });
        if (delivery === "interrupted") expect(f.recorded[1]?.voice?.playedAudioMs).toBe(125);
        yield* f.bridge.receive({ type: "relay.playback.done", response_id: "reply" });
        expect(f.recorded[1]?.voice?.delivery).toBe(delivery);
        expect(f.sent).toHaveLength(0);
      }),
    ).pipe(Effect.timeout("3 seconds")),
);
