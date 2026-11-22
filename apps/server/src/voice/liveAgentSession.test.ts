import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { LiveConnectionError } from "@t3tools/provider-core/server/liveConnection";
import {
  CommandId,
  ProjectId,
  EventId,
  OrchestrationV2RunJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  ProviderTurnId,
  RunAttemptId,
  ProviderThreadId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  TurnItemId,
  type LiveVoiceServerEvent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as VoiceFixture from "../orchestration-v2/VoiceConversation.testkit.ts";
import { makeLiveAgentSession } from "./liveAgentSession.ts";
import { readLiveHistory } from "./liveHistory.ts";
import {
  decodeNativeLiveEvent,
  encodeNativeLiveAppend,
  type NativeLiveAppend,
} from "./liveProtocol.ts";

const pendingCards = (count: number): OrchestrationV2RuntimeRequest[] =>
  Array.from({ length: count }, (_, index) => ({
    id: RuntimeRequestId.make(`pending-card-${index}-${"x".repeat(96)}`),
    nodeId: NodeId.make("unrelated-node"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: DateTime.makeUnsafe(0),
    resolvedAt: null,
  }));
const escapedText = '"C:\\x"\n';
import parentCapture from "./fixtures/live-native/parent-association.json" with { type: "json" };
import stallCapture from "./fixtures/live-native/handoff-stall.json" with { type: "json" };
import resultCapture from "./fixtures/live-native/result-association.json" with { type: "json" };

const decodeCapturedResult = Schema.decodeUnknownSync(
  Schema.Struct({
    run: OrchestrationV2RunJson,
    attempt: OrchestrationV2RunAttemptJson,
    providerTurn: OrchestrationV2ProviderTurnJson,
    typedFinal: OrchestrationV2TurnItemJson,
    finalMessage: OrchestrationV2ConversationMessageJson,
  }),
);

const services = Layer.mergeAll(
  VoiceFixture.layer,
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/fixture/projects",
  }),
);

it.effect("captured request and acknowledgement without delegation never submit work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:captured-stall");
      yield* VoiceFixture.create(threadId);
      const threads = yield* ThreadManagement.ThreadManagementService;
      const agent = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "captured-stall",
        onBound: () => {},
        send: () => Effect.void,
        append: () => Effect.void,
      });
      for (const frame of stallCapture.frames) {
        const event = decodeNativeLiveEvent(JSON.stringify(frame.payload));
        if (event) yield* agent.receive(event);
      }
      yield* TestClock.adjust("140 seconds");
      yield* agent.poll;
      const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
      expect(records.runs).toHaveLength(0);
      expect(records.messages.map((message) => message.text)).toEqual(
        stallCapture.frames
          .filter((frame) => frame.payload.type === "turn.done")
          .map((frame) => frame.payload.turn.transcript),
      );
      expect(records.messages.every((message) => message.runId === null)).toBe(true);
    }),
  ).pipe(Effect.provide(services)),
);

it.effect(
  "captured precompletion delegations wait for their exact native parent and submit once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:captured-parents");
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "captured-parents",
          onBound: () => {},
          send: () => Effect.void,
          append: () => Effect.void,
        });
        let expected = 0;
        for (const frame of parentCapture.frames) {
          const event = decodeNativeLiveEvent(JSON.stringify(frame.payload));
          if (event) yield* agent.receive(event);
          if (frame.payload.type === "turn.done" && frame.payload.turn?.id !== "turn_greeting")
            expected++;
          expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(expected);
        }
        // Replays of an old parent must never borrow the greeting's authority.
        for (const frame of parentCapture.frames.filter(
          (frame) => frame.payload.type === "delegation.created",
        )) {
          const event = decodeNativeLiveEvent(JSON.stringify(frame.payload));
          if (event) yield* agent.receive(event);
        }
        const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
        expect(records.runs).toHaveLength(3);
        for (const name of ["request", "correction", "next"]) {
          const speech = records.messages.find(
            (message) => message.voice?.itemId === `turn_${name}`,
          );
          expect(speech).toBeDefined();
          const submitted = records.messages.find(
            (message) => message.runId && message.id === speech!.id,
          );
          expect(submitted?.text).toContain(speech!.text.trim());
          expect(submitted?.createdBy).toBe("user");
        }
        expect(records.messages.filter((message) => message.voice)).toHaveLength(4);
      }),
    ).pipe(Effect.provide(services)),
);

it.live(
  "delegation promotes canonical speech once and keeps generated voice history separate",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:live-derived-test");
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const events: LiveVoiceServerEvent[] = [];
        const appends: NativeLiveAppend[] = [];
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "fictional-session",
          onBound: () => {},
          send: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          append: (event) =>
            Effect.sync(() => {
              appends.push(event);
            }),
        });
        yield* agent.seed;
        yield* agent.receive({
          type: "transcript",
          role: "user",
          itemId: "chunk-one",
          text: "The kite is teal",
        });
        yield* agent.receive({
          type: "transcript",
          role: "user",
          itemId: "chunk-one",
          text: "The kite is teal",
        }); // replay
        yield* agent.receive({
          type: "transcript",
          role: "assistant",
          itemId: "chunk-two",
          text: "Understood.",
        }); // concurrent before final user turn
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          turnId: "turn-one",
          text: "The kite is blue, not red. Do not change files.",
        });
        yield* agent.receive({
          type: "turn_done",
          role: "assistant",
          turnId: "turn-two",
          text: "Understood.",
        });
        const before = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
        expect(before.runs).toHaveLength(0);
        expect(before.messages).toHaveLength(2);
        const speech = before.messages.find((message) => message.role === "user")!;
        expect(speech.text).toBe("The kite is blue, not red. Do not change files.");
        expect(speech.voice?.transcriptFinality).toBe("application_frozen");
        expect(speech.voice?.delivery).toBe("unknown");
        expect(
          before.messages.find((message) => message.role === "assistant")?.voice?.textKind,
        ).toBe("generated_voice_reply");
        expect(
          events.filter((event) => event.type === "live.caption" && event.committed),
        ).toHaveLength(2);
        const delegation = {
          type: "delegation",
          delegationId: "delegation-one",
          userTurnId: "turn-one",
          instructions: "Inspect the fictional kite setting. Do not change files.",
          provenance: "native_live_delegation",
        } as const;
        yield* agent.receive(delegation);
        yield* agent.receive(delegation);
        yield* agent.receive({ ...delegation, delegationId: "delegation-replay" });
        const after = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
        expect(after.runs).toHaveLength(1);
        const submitted = after.messages.find((message) => message.runId === after.runs[0]!.id)!;
        expect(after.messages).toHaveLength(2);
        expect(submitted.id).toBe(speech.id);
        expect(submitted.createdBy).toBe("user");
        expect(submitted.creationSource).toBe("web");
        expect(submitted.voice).toEqual(speech.voice);
        expect(submitted.text).toBe(speech.text);
        expect(submitted.text).not.toContain(delegation.instructions);
        expect(appends.some((event) => event.text.includes("ambiguous_repeat"))).toBe(true);
        expect(appends.some((event) => event.text.includes("not a completion result"))).toBe(true);
        const replay: NativeLiveAppend[] = [];
        const replacement = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "fictional-replacement",
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.sync(() => {
              replay.push(event);
            }),
        });
        const hydrated = yield* replacement.seed;
        expect(hydrated).toContain("The kite is blue, not red. Do not change files.");
        expect(hydrated).toContain("T3_bound_history");
        expect(replay).toHaveLength(0);
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(1);
      }),
    ).pipe(Effect.provide(services)),
);

it.live(
  "typed input is already admitted: acknowledge/context/status only, never redispatch it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:live-typed-test");
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const events: LiveVoiceServerEvent[] = [];
        const appends: NativeLiveAppend[] = [];
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "fictional-typed-session",
          onBound: () => {},
          send: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          append: (event) =>
            Effect.sync(() => {
              appends.push(event);
            }),
        });
        yield* agent.seed;
        const sent = yield* threads.sendToThread({
          projectId: VoiceFixture.projectId,
          threadId,
          commandId: CommandId.make("typed-input"),
          messageId: MessageId.make("typed-input"),
          text: "Inspect the fictional blue kite. Do not change files.",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        yield* agent.poll;
        yield* agent.poll;
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(1);
        expect(
          events.filter(
            (event) =>
              event.type === "live.agent" &&
              event.runId === sent.run.id &&
              ["accepted", "queued"].includes(event.status),
          ),
        ).toHaveLength(1);
        expect(
          appends.some(
            (event) =>
              event.text.includes("T3_typed_request") && event.text.includes("fictional blue kite"),
          ),
        ).toBe(true);
        expect(appends.every((event) => event.delegationId === undefined)).toBe(true);
      }),
    ).pipe(Effect.provide(services)),
);

it.live("Stop/disconnect freezes pending concurrent caption windows but never submits them", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:live-finalize-test");
    yield* VoiceFixture.create(threadId);
    const events: LiveVoiceServerEvent[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "fictional-finalize-session",
          onBound: () => {},
          send: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          append: () => Effect.void,
        });
        yield* agent.receive({
          type: "transcript",
          role: "user",
          itemId: "in-one",
          text: "Keep this correction; do not change files.",
        });
        yield* agent.receive({
          type: "transcript",
          role: "assistant",
          itemId: "out-one",
          text: "I understand the correction.",
        });
      }),
    );
    const threads = yield* ThreadManagement.ThreadManagementService;
    const saved = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
    expect(saved.runs).toHaveLength(0);
    expect(saved.messages.map((message) => message.text)).toEqual([
      "Keep this correction; do not change files.",
      "I understand the correction.",
    ]);
    expect(
      saved.messages.every(
        (message) =>
          message.voice?.transcriptFinality === "application_frozen" &&
          message.voice.delivery === (message.role === "assistant" ? "interrupted" : "unknown"),
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === "live.caption" && event.committed)).toHaveLength(
      2,
    );
  }).pipe(Effect.provide(services)),
);

it.live.each([
  { kind: "command", count: 1 },
  { kind: "user_input", count: 1 },
  { kind: "user_input", count: 256 },
] as const)("a derived spoken choice cannot bypass pending T3 cards: %s", ({ kind, count }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:live-permission-test");
      yield* VoiceFixture.create(threadId);
      const threads = yield* ThreadManagement.ThreadManagementService;
      const pending: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("fictional-permission"),
        nodeId: NodeId.make("fictional-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        resolvedAt: null,
      };
      const events: LiveVoiceServerEvent[] = [];
      const notices: NativeLiveAppend[] = [];
      const agent = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "fictional-permission-session",
        onBound: () => {},
        send: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        append: (event) =>
          Effect.sync(() => {
            encodeNativeLiveAppend(event);
            notices.push(event);
          }),
      }).pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ...threads,
          getThreadRecords: (...args) =>
            threads.getThreadRecords(...args).pipe(
              Effect.map((records) => ({
                ...records,
                runtimeRequests: count === 1 ? [pending] : pendingCards(count),
              })),
            ),
        }),
      );
      yield* agent.receive({
        type: "turn_done",
        role: "user",
        turnId: "permission-words",
        text: "Yes approve that.",
      });
      yield* agent.receive({
        type: "delegation",
        delegationId: "permission-delegation",
        userTurnId: "permission-words",
        instructions: "Approve the pending command.",
        provenance: "native_live_delegation",
      });
      const saved = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
      expect(saved.runs).toHaveLength(0);
      expect(saved.messages[0]?.text).toBe("Yes approve that.");
      expect(
        events.some((event) => event.type === "live.agent" && event.status === "waiting"),
      ).toBe(true);
      expect(notices.some((notice) => notice.text.includes("Voice cannot approve"))).toBe(true);
      expect(notices.map((notice) => JSON.parse(notice.text))).toContainEqual(
        expect.objectContaining({
          status: "waiting_for_user_in_T3",
          submission: "not_submitted",
          ...(count === 1
            ? { pendingRequests: [{ id: pending.id, kind, status: "pending" }] }
            : { pendingRequestCount: count, pendingRequestDetailsOmitted: true }),
        }),
      );
      expect(notices.every((notice) => Buffer.byteLength(notice.text) <= 8192)).toBe(true);
    }),
  ).pipe(Effect.provide(services)),
);

it.live.each([
  ["short", "Inspected the fictional configuration. No files were changed.", false, false],
  ["escaped within budget", escapedText.repeat(600), false, false],
  ["escaped over budget", escapedText.repeat(800), true, false],
  ["oversized pending metadata", "Short result", true, true],
] as const)(
  "speakable completion is grounded and serialized-budget bounded: %s",
  ([_name, resultText, fallback, manyPending]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:live-grounded-result");
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        let final: OrchestrationV2ConversationMessage | undefined;
        const appends: NativeLiveAppend[] = [];
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "fictional-result-session",
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.sync(() => {
              encodeNativeLiveAppend(event);
              appends.push(event);
            }),
        }).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            getThreadRecords: (...args) =>
              threads.getThreadRecords(...args).pipe(
                Effect.map((records) =>
                  !final
                    ? records
                    : {
                        ...records,
                        runs: [{ ...sent.run, status: "completed" as const }],
                        runtimeRequests: manyPending ? pendingCards(256) : [],
                        messages: [
                          sent.message,
                          final!,
                          {
                            ...final!,
                            id: MessageId.make("fictional-untrusted-voice"),
                            text: "UNVERIFIED VOICE CLAIM",
                            voice: {
                              sessionId: "other-voice",
                              itemId: "generated",
                              sequence: 0,
                              textKind: "generated_voice_reply" as const,
                              delivery: "unknown" as const,
                            },
                          },
                        ],
                      },
                ),
              ),
          }),
        );
        yield* agent.seed;
        const sent = yield* threads.sendToThread({
          projectId: VoiceFixture.projectId,
          threadId,
          commandId: CommandId.make("grounded-typed"),
          messageId: MessageId.make("grounded-typed"),
          text: escapedText.repeat(5000),
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        yield* agent.poll;
        expect((yield* threads.getThreadRecords(threadId, ["messages"])).messages[0]?.text).toBe(
          sent.message.text,
        );
        expect(appends.every((event) => !event.text.includes("actualAgentResult"))).toBe(true);
        expect(appends.some((event) => event.text.includes("Read full typed request in T3"))).toBe(
          true,
        );
        final = {
          ...sent.message,
          id: MessageId.make("fictional-authored-final"),
          runId: sent.run.id,
          role: "assistant",
          createdBy: "agent",
          creationSource: "server",
          text: resultText,
        };
        yield* projections.apply({
          id: EventId.make("stored-escaped-result"),
          type: "message.updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: final,
        });
        yield* agent.poll;
        yield* agent.poll;
        const results = appends.filter((event) => JSON.parse(event.text).status === "completed");
        expect(results).toHaveLength(1);
        if (manyPending)
          expect(JSON.parse(results[0]!.text)).toMatchObject({
            pendingRequestCount: 256,
            pendingRequestDetailsOmitted: true,
            sourceRevisionsOmitted: true,
          });
        expect(Buffer.byteLength(results[0]!.text, "utf8")).toBeLessThanOrEqual(8192);
        const result = JSON.parse(results[0]!.text);
        if (fallback) {
          expect(result.note).toBe("The result is too long for voice; read the written T3 result.");
          expect(result.actualAgentResult).toBeUndefined();
        } else {
          expect(result.actualAgentResult).toBe(final.text.trim());
          expect(result.sourceMessageIds).toContain(final.id);
        }
        expect(
          (yield* threads.getThreadRecords(threadId, ["messages"])).messages.find(
            (message) => message.id === final!.id,
          )?.text,
        ).toBe(resultText);
        expect(results[0]?.text).not.toContain("UNVERIFIED VOICE CLAIM");
        yield* agent.bind;
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(1);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect("only fresh human input authorizes delegation, including after completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:live-human-authority");
      yield* VoiceFixture.create(threadId);
      const threads = yield* ThreadManagement.ThreadManagementService;
      let completed = false;
      const agent = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "authority-session",
        onBound: () => {},
        send: () => Effect.void,
        append: () => Effect.void,
      }).pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ...threads,
          getThreadRecords: (...args) =>
            Effect.gen(function* () {
              const records = yield* threads.getThreadRecords(...args);
              const { runs } = yield* threads.getThreadRecords(args[0], ["runs"]);
              return {
                ...records,
                runs: runs.map((run) =>
                  completed ? { ...run, status: "completed" as const } : run,
                ),
              };
            }),
        }),
      );
      yield* agent.seed;
      const delegation = {
        type: "delegation",
        delegationId: "no-human",
        userTurnId: "human-one",
        instructions: "Inspect the fictional setting.",
        provenance: "native_live_delegation",
      } as const;
      yield* agent.receive(delegation);
      expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
      yield* agent.receive({
        type: "turn_done",
        role: "user",
        turnId: "human-one",
        text: "Inspect it.",
      });
      yield* agent.receive({ ...delegation, delegationId: "first" });
      completed = true;
      yield* agent.poll;
      yield* agent.receive({
        type: "turn_done",
        role: "assistant",
        turnId: "assistant-one",
        text: "Finished.",
      });
      yield* agent.receive({ ...delegation, delegationId: "first" });
      yield* agent.receive({ ...delegation, delegationId: "fresh-id" });
      yield* agent.receive({
        ...delegation,
        delegationId: "changed-summary",
        instructions: "Check that setting again.",
      });
      expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(1);
      // Distinct native turns may legitimately contain identical human words.
      yield* agent.receive({
        type: "turn_done",
        role: "user",
        turnId: "human-two",
        text: "Inspect it.",
      });
      completed = false;
      yield* agent.receive({ ...delegation, delegationId: "second", userTurnId: "human-two" });
      yield* agent.receive({
        type: "transcript",
        role: "user",
        itemId: "correction-draft",
        text: "Make it red",
      });
      yield* agent.receive({
        type: "turn_done",
        role: "user",
        turnId: "human-three",
        text: "No, inspect blue only. Do not edit.",
      });
      yield* agent.receive({
        ...delegation,
        delegationId: "correction",
        userTurnId: "human-three",
        instructions: "Inspect blue only. Do not edit.",
      });
      yield* agent.receive({
        ...delegation,
        delegationId: "correction-replay",
        userTurnId: "human-three",
        instructions: "Inspect the blue setting without edits.",
      });
      const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
      expect(records.runs).toHaveLength(3);
      expect(
        records.messages.some((message) => message.text === "No, inspect blue only. Do not edit."),
      ).toBe(true);
      // An ID-less repeat without new transcript input cannot prove a new utterance.
      yield* agent.receive({
        type: "turn_done",
        role: "user",
        text: "No, inspect blue only. Do not edit.",
      });
      yield* agent.receive({ ...delegation, delegationId: "idless-followup" });
      expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(3);
    }),
  ).pipe(Effect.provide(services)),
);

it.effect(
  "claims human authority before awaiting dispatch and retains it after ambiguous failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:live-authority-race");
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        let ambiguous = false;
        const guarded: typeof threads = {
          ...threads,
          sendToThread: (input) =>
            Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              const sent = yield* threads.sendToThread(input);
              if (ambiguous)
                return yield* new ThreadManagement.ThreadManagementProjectionLoadError({
                  projectId: VoiceFixture.projectId,
                  threadId,
                  cause: new Error("Lost response after commit"),
                });
              return sent;
            }),
        };
        yield* Effect.gen(function* () {
          const agent = yield* makeLiveAgentSession({
            binding: { threadId },
            sessionId: "authority-race",
            onBound: () => {},
            send: () => Effect.void,
            append: () => Effect.void,
          });
          yield* agent.seed;
          yield* agent.receive({
            type: "turn_done",
            role: "user",
            turnId: "race-human",
            text: "Inspect the setting.",
          });
          const delegation = {
            type: "delegation",
            provenance: "native_live_delegation",
            delegationId: "race-first",
            userTurnId: "race-human",
            instructions: "Inspect the setting.",
          } as const;
          const first = yield* agent.receive(delegation).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* agent.receive({
            ...delegation,
            delegationId: "racing-replay",
            instructions: "Inspect that setting.",
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          expect(calls).toBe(1);
          yield* agent.receive({
            type: "turn_done",
            role: "user",
            turnId: "second-human",
            text: "Now inspect the other setting.",
          });
          ambiguous = true;
          const result = yield* agent
            .receive({ ...delegation, delegationId: "lost-response", userTurnId: "second-human" })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          yield* agent.receive({
            ...delegation,
            delegationId: "ambiguous-replay",
            userTurnId: "second-human",
            instructions: "Inspect the other setting again.",
          });
          expect(calls).toBe(2);
          expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(2);
        }).pipe(Effect.provideService(ThreadManagement.ThreadManagementService, guarded));
      }),
    ).pipe(Effect.provide(services)),
);

it.effect(
  "typed discovery waits for finalized text and catches up in bounded batches without replay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:live-typed-catchup");
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const notices: NativeLiveAppend[] = [];
        const events: LiveVoiceServerEvent[] = [];
        let oldest: MessageId | undefined;
        let provisional = true;
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "catchup-session",
          onBound: () => {},
          send: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          append: (notice) =>
            Effect.sync(() => {
              notices.push(notice);
            }),
        }).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            getThreadRecords: (...args) =>
              Effect.gen(function* () {
                const records = yield* threads.getThreadRecords(...args);
                const { messages } = yield* threads.getThreadRecords(args[0], ["messages"]);
                return {
                  ...records,
                  messages: messages.map((message) =>
                    provisional && message.id === oldest
                      ? {
                          ...message,
                          streaming: true,
                          text: "Provisional text must not be acknowledged",
                        }
                      : message,
                  ),
                };
              }),
          }),
        );
        yield* agent.seed;
        const runIds: RunId[] = [];
        for (let index = 0; index < 10; index++) {
          const sent = yield* threads.sendToThread({
            projectId: VoiceFixture.projectId,
            threadId,
            commandId: CommandId.make(`catchup-${index}`),
            messageId: MessageId.make(`catchup-${index}`),
            text: `Final request ${index}.`,
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          });
          oldest ??= sent.message.id;
          runIds.push(sent.run.id);
        }
        const acknowledgments = () =>
          events.flatMap((event) =>
            event.type === "live.agent" &&
            (event.status === "accepted" || event.status === "queued")
              ? [event.runId]
              : [],
          );
        yield* agent.poll;
        expect(acknowledgments()).toHaveLength(0);
        provisional = false;
        yield* agent.poll;
        expect(acknowledgments()).toHaveLength(8);
        yield* agent.poll;
        yield* agent.poll;
        expect(acknowledgments()).toEqual(runIds);
        expect(notices.filter((notice) => notice.text.includes("T3_typed_request"))).toHaveLength(
          10,
        );
        expect(notices.every((notice) => !notice.text.includes("Provisional text"))).toBe(true);
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(10);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect("assistant previews stay provisional across admission and idle, then persist once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:assistant-final-once");
      yield* VoiceFixture.create(threadId);
      const threads = yield* ThreadManagement.ThreadManagementService;
      const agent = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "assistant-final-once",
        onBound: () => {},
        send: () => Effect.void,
        append: () => Effect.void,
      });
      yield* agent.seed;
      yield* agent.receive({
        type: "turn_created",
        role: "user",
        turnId: "human",
        text: "Help me.",
      });
      yield* agent.receive({ type: "turn_done", role: "user", turnId: "human", text: "Help me." });
      yield* agent.receive({
        type: "transcript",
        role: "assistant",
        itemId: "preview",
        text: "I'll get some",
      });
      yield* agent.receive({
        type: "delegation",
        delegationId: "task",
        userTurnId: "human",
        instructions: "Help",
        provenance: "native_live_delegation",
      });
      yield* TestClock.adjust("10 seconds");
      yield* agent.poll;
      expect(
        (yield* threads.getThreadRecords(threadId, ["messages"])).messages.filter(
          (m) => m.role === "assistant",
        ),
      ).toHaveLength(0);
      yield* agent.receive({
        type: "turn_done",
        role: "assistant",
        turnId: "reply",
        text: "I'll get some recommendations for you.",
      });
      yield* agent.receive({
        type: "turn_done",
        role: "assistant",
        turnId: "reply",
        text: "I'll get some recommendations for you.",
      });
      const messages = (yield* threads.getThreadRecords(threadId, ["messages"])).messages.filter(
        (m) => m.role === "assistant",
      );
      expect(messages.map((m) => m.text)).toEqual(["I'll get some recommendations for you."]);
      expect(messages[0]?.voice?.delivery).toBe("unknown");
      const history = yield* readLiveHistory(threadId);
      expect(history.messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual([
        "I'll get some recommendations for you.",
      ]);
      const reconnectHistory: NativeLiveAppend[] = [];
      const reconnected = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "assistant-reconnected",
        onBound: () => {},
        send: () => Effect.void,
        append: (event) =>
          Effect.sync(() => {
            reconnectHistory.push(event);
          }),
      });
      const hydrated = yield* reconnected.seed;
      expect(yield* reconnected.seed).toBe(hydrated);
      expect(hydrated).toContain("I'll get some recommendations for you.");
      expect(reconnectHistory).toHaveLength(0);
    }),
  ).pipe(Effect.provide(services)),
);

it.effect(
  "a replaced unfinished assistant turn retains interruption without accepting its late full text",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:assistant-interruption");
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "interrupted-reply",
          onBound: () => {},
          send: () => Effect.void,
          append: () => Effect.void,
        });
        yield* agent.receive({
          type: "turn_created",
          role: "assistant",
          turnId: "first",
          text: "I'll get some",
        });
        yield* agent.receive({
          type: "turn_created",
          role: "assistant",
          turnId: "second",
          text: "Understood",
        });
        yield* agent.receive({
          type: "turn_done",
          role: "assistant",
          turnId: "first",
          text: "I'll get some recommendations for you.",
        });
        yield* agent.receive({
          type: "turn_done",
          role: "assistant",
          turnId: "second",
          text: "Understood; keep the correction.",
        });
        const messages = (yield* threads.getThreadRecords(threadId, ["messages"])).messages;
        expect(messages.map((m) => m.text)).toEqual([
          "I'll get some",
          "Understood; keep the correction.",
        ]);
        expect(messages.map((m) => m.voice?.delivery)).toEqual(["interrupted", "unknown"]);
        expect((yield* readLiveHistory(threadId)).messages.map((m) => m.voice?.delivery)).toEqual([
          "interrupted",
          "unknown",
        ]);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect(
  "inactivity keeps assistant preview provisional; completion and Stop do not duplicate history",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:live-inactivity");
      yield* VoiceFixture.create(threadId);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* makeLiveAgentSession({
            binding: { threadId },
            sessionId: "inactivity-session",
            onBound: () => {},
            send: () => Effect.void,
            append: () => Effect.void,
          });
          yield* agent.seed;
          for (const role of ["user", "assistant"] as const)
            yield* agent.receive({
              type: "transcript",
              role,
              itemId: `initial-${role}`,
              text: `Initial ${role}.`,
            });
          yield* TestClock.adjust("10 seconds");
          yield* agent.poll;
          const threads = yield* ThreadManagement.ThreadManagementService;
          expect((yield* threads.getThreadRecords(threadId, ["messages"])).messages).toHaveLength(
            0,
          );
          for (const role of ["user", "assistant"] as const) {
            yield* agent.receive({
              type: "turn_done",
              role,
              turnId: `late-${role}`,
              text: `Initial ${role}.`,
            });
            yield* agent.receive({
              type: "transcript",
              role,
              itemId: `continued-${role}`,
              text: `Continued ${role}.`,
            });
            yield* agent.receive({
              type: "turn_done",
              role,
              turnId: `corrected-${role}`,
              text: `Corrected ${role}.`,
            });
          }
          yield* agent.poll;
        }),
      );
      const records = yield* (yield* ThreadManagement.ThreadManagementService).getThreadRecords(
        threadId,
        ["messages", "runs"],
      );
      expect(records.runs).toHaveLength(0);
      expect(records.messages.map((message) => message.text)).toEqual([
        "Initial user.",
        "Corrected user.",
        "Initial assistant.",
        "Corrected assistant.",
      ]);
      expect(
        records.messages.every(
          (message) => message.voice?.transcriptFinality === "application_frozen",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(services)),
);

it.effect.each([
  { escaped: false, notifications: "progress" },
  { escaped: true, notifications: "progress" },
  { escaped: false, notifications: "terminal" },
] as const)(
  "notifications respect speech and opt-in progress ($notifications, escaped: $escaped)",
  ({ escaped, notifications }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:live-stale-narration");
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const notices: NativeLiveAppend[] = [];
        const sent: Array<{
          run: OrchestrationV2Run;
          message: OrchestrationV2ConversationMessage;
        }> = [];
        for (let index = 0; index < 2; index++)
          sent.push(
            yield* threads.sendToThread({
              projectId: VoiceFixture.projectId,
              threadId,
              commandId: CommandId.make(`narration-${index}`),
              messageId: MessageId.make(`narration-${index}`),
              text: `Fictional task ${index}.`,
              attachments: [],
              mode: "queue",
              createdBy: "user",
              creationSource: "web",
            }),
          );
        let timestamp = DateTime.makeUnsafe(0);
        let completed = false;
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "stale-session",
          preferences: { voice: "maple", notifications },
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.sync(() => {
              encodeNativeLiveAppend(event);
              notices.push(event);
            }),
        }).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            getThreadRecords: (...args) =>
              Effect.gen(function* () {
                const records = yield* threads.getThreadRecords(...args);
                const { runs, messages } = yield* threads.getThreadRecords(args[0], [
                  "runs",
                  "messages",
                ]);
                return {
                  ...records,
                  runs: runs.map((run) =>
                    completed ? { ...run, status: "completed" as const } : run,
                  ),
                  messages: [
                    ...messages,
                    ...sent.map(({ run, message }, index) => ({
                      ...message,
                      id: MessageId.make(`commentary-${index}-${"x".repeat(96)}`),
                      runId: run.id,
                      role: "assistant" as const,
                      createdBy: "agent" as const,
                      text: escaped ? '"\\\n'.repeat(1333) : `Grounded commentary ${index}.`,
                      createdAt: timestamp,
                      updatedAt: timestamp,
                    })),
                  ],
                  turnItems: sent.map(({ run }, index): OrchestrationV2TurnItem => ({
                    id: TurnItemId.make(`commentary-item-${index}`),
                    threadId,
                    runId: run.id,
                    nodeId: run.rootNodeId,
                    ordinal: index,
                    type: "assistant_message",
                    status: "completed",
                    startedAt: timestamp,
                    completedAt: timestamp,
                    messageId: MessageId.make(`commentary-${index}-${"x".repeat(96)}`),
                    phase: completed ? "final_answer" : "commentary",
                    text: "",
                    textOmitted: true,
                    streaming: false,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    title: null,
                    updatedAt: timestamp,
                  })),
                };
              }),
          }),
        );
        yield* agent.seed;
        yield* TestClock.adjust("25 seconds");
        yield* agent.poll;
        expect(
          notices.filter((notice) => notice.text.includes('"status":"progress"')),
        ).toHaveLength(0);
        timestamp = DateTime.makeUnsafe(25000);
        yield* agent.poll;
        const progress = notices.filter((notice) => notice.text.includes('"status":"progress"'));
        expect(progress).toHaveLength(notifications === "progress" ? 1 : 0);
        if (progress[0])
          expect(Buffer.byteLength(progress[0].text, "utf8")).toBeLessThanOrEqual(8192);
        if (escaped && progress[0]) {
          expect(JSON.parse(progress[0]!.text).actualAgentCommentary).toBeUndefined();
          expect(progress[0]!.text).toContain("Read the written T3 result");
        }
        yield* TestClock.adjust("20 seconds");
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          turnId: "newer-human",
          text: "Use my newer correction.",
        });
        yield* agent.poll;
        expect(
          notices.filter((notice) => notice.text.includes('"status":"progress"')),
        ).toHaveLength(notifications === "progress" ? 1 : 0);
        yield* agent.receive({
          type: "turn_created",
          role: "user",
          turnId: "speaking",
          text: "One more",
        });
        yield* agent.receive({ type: "turn_delta", turnId: "speaking", text: " constraint" });
        completed = true;
        yield* agent.poll;
        expect(notices.filter((n) => JSON.parse(n.text).status === "completed")).toHaveLength(0);
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          turnId: "speaking",
          text: "One more constraint.",
        });
        yield* agent.receive({
          type: "turn_created",
          role: "user",
          turnId: "older-overlap",
          text: "Wait",
        });
        yield* agent.receive({
          type: "turn_created",
          role: "user",
          turnId: "rapid-followup",
          text: "And",
        });
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          turnId: "older-overlap",
          text: "Wait.",
        });
        yield* agent.poll;
        expect(notices.filter((n) => JSON.parse(n.text).status === "completed")).toHaveLength(0);
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          turnId: "rapid-followup",
          text: "And keep approvals.",
        });
        yield* agent.poll;
        yield* agent.poll;
        const finals = notices.filter((notice) => JSON.parse(notice.text).status === "completed");
        expect(finals).toHaveLength(2);
        for (let index = 0; index < 2; index++) {
          if (!escaped)
            expect(finals.some((notice) => notice.text.includes(`commentary-${index}`))).toBe(true);
          expect(finals.some((notice) => notice.text.includes(sent[index]!.run.id))).toBe(true);
        }
      }),
    ).pipe(Effect.provide(services)),
);

it.live.each([false, true])(
  "partial/final corrections need an identified parent and never grant partial authority (IDs: %s)",
  (withIds) =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make(`thread:partial-final-${withIds}`);
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: `partial-${withIds}`,
          onBound: () => {},
          send: () => Effect.void,
          append: () => Effect.void,
        });
        yield* agent.seed;
        const delegate = (delegationId: string, userTurnId = "final-one") =>
          agent.receive({
            type: "delegation",
            delegationId,
            userTurnId,
            instructions: "Inspect blue only. Do not edit.",
            provenance: "native_live_delegation",
          });
        yield* agent.receive({
          type: "transcript",
          role: "user",
          text: "Inspect it",
          ...(withIds ? { itemId: "partial-one" } : {}),
        });
        yield* delegate("premature");
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
        yield* agent.receive({
          type: "transcript",
          role: "user",
          text: ", blue only",
          ...(withIds ? { itemId: "partial-two" } : {}),
        });
        yield* delegate("second-partial");
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          text: "Inspect blue only. Do not edit.",
          ...(withIds ? { turnId: "final-one" } : {}),
        });
        yield* delegate("final");
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          text: "Inspect blue only. Do not edit.",
          ...(withIds ? { turnId: "final-one" } : {}),
        });
        yield* delegate("replayed-final");
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(
          withIds ? 1 : 0,
        );
        yield* agent.receive({
          type: "transcript",
          role: "user",
          text: "Now inspect green.",
          ...(withIds ? { itemId: "next-partial" } : {}),
        });
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          text: "Now inspect green.",
          ...(withIds ? { turnId: "final-two" } : {}),
        });
        yield* delegate("genuine-followup", "final-two");
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(
          withIds ? 2 : 0,
        );
      }),
    ).pipe(Effect.provide(services)),
);

it.live.each([
  "before-admission",
  "before-commit",
  "pending-before-admission",
  "pending-before-commit",
] as const)("typed submission %s wins without a poll", (timing) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:typed-before-delegation");
      yield* VoiceFixture.create(threadId);
      const threads = yield* ThreadManagement.ThreadManagementService;
      const typed = threads.sendToThread({
        projectId: VoiceFixture.projectId,
        threadId,
        commandId: CommandId.make("typed-race"),
        messageId: MessageId.make("typed-race"),
        text: "Inspect blue only. Do not edit.",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      let injected = false;
      const guarded: typeof threads = {
        ...threads,
        sendToThread: (input) =>
          Effect.gen(function* () {
            if (timing.endsWith("before-commit") && !injected) {
              injected = true;
              yield* typed;
            }
            return yield* threads.sendToThread(input);
          }),
      };
      const agent = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "typed-race",
        onBound: () => {},
        send: () => Effect.void,
        append: () => Effect.void,
      });
      yield* agent.seed;
      const final = {
        type: "turn_done",
        role: "user",
        turnId: "speech",
        text: "Inspect the blue setting.",
      } as const;
      const delegation = {
        type: "delegation",
        delegationId: "typed-duplicate",
        userTurnId: "speech",
        instructions: "Inspect the blue setting.",
        provenance: "native_live_delegation",
      } as const;
      if (timing.startsWith("pending")) {
        yield* agent.receive({ ...final, type: "turn_created" });
        yield* agent.receive(delegation);
        if (timing.endsWith("before-admission")) yield* typed;
        yield* agent
          .receive(final)
          .pipe(Effect.provideService(ThreadManagement.ThreadManagementService, guarded));
      } else {
        yield* agent.receive(final);
        if (timing === "before-admission") yield* typed;
        yield* agent
          .receive(delegation)
          .pipe(Effect.provideService(ThreadManagement.ThreadManagementService, guarded));
      }
      const admitted = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
      expect(admitted.runs).toHaveLength(1);
      expect(admitted.runs[0]?.userMessageId).toBe(MessageId.make("typed-race"));
      expect(
        admitted.messages.find((message) => message.id === MessageId.make("typed-race"))?.text,
      ).toBe("Inspect blue only. Do not edit.");
      yield* agent.receive({
        type: "turn_done",
        role: "user",
        turnId: "next-speech",
        text: "Now inspect the green setting.",
      });
      yield* agent.receive({
        type: "delegation",
        delegationId: "typed-followup",
        userTurnId: "next-speech",
        instructions: "Inspect the green setting.",
        provenance: "native_live_delegation",
      });
      expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(2);
    }),
  ).pipe(Effect.provide(services)),
);

it.live.each([
  "Read the file.",
  "Read the blue file only. Do not edit.",
  "Actually only inspect it; do not edit.",
])("late final %s cannot reauthorize a partial delegation", (finalText) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:late-corrected-final");
      yield* VoiceFixture.create(threadId);
      const threads = yield* ThreadManagement.ThreadManagementService;
      const agent = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "late-final",
        onBound: () => {},
        send: () => Effect.void,
        append: () => Effect.void,
      });
      yield* agent.seed;
      yield* agent.receive({
        type: "transcript",
        role: "user",
        itemId: "chunk",
        text: "Read the file",
      });
      const delegation = {
        type: "delegation",
        provenance: "native_live_delegation",
        delegationId: "early",
        userTurnId: "final",
        instructions: "Edit the file.",
      } as const;
      if (finalText.startsWith("Actually"))
        yield* agent.receive({
          type: "turn_created",
          role: "user",
          turnId: "final",
          text: "Edit the file.",
        });
      yield* agent.receive(delegation);
      expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
      yield* agent.receive({ type: "turn_done", role: "user", turnId: "final", text: finalText });
      yield* agent.receive({ ...delegation, delegationId: "late" });
      const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
      expect(records.runs).toHaveLength(1);
      expect(records.messages.find((message) => message.voice)?.text).toBe(finalText);
      const task = records.messages.find((message) => message.runId)?.text;
      expect(task).toBe(finalText);
      expect(records.messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(task).not.toContain("Edit the file.");
    }),
  ).pipe(Effect.provide(services)),
);

it.effect.each(["reordered", "interleaved", "unassociated", "handoff-replay"] as const)(
  "%s native parents never borrow another turn's authority",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make(`thread:parent-${scenario}`);
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const notices: NativeLiveAppend[] = [];
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: `parent-${scenario}`,
          onBound: () => {},
          send: () => Effect.void,
          append: (notice) =>
            Effect.sync(() => {
              notices.push(notice);
            }),
        });
        const created = (turnId: string) =>
          agent.receive({ type: "turn_created", role: "user", turnId, text: `Partial ${turnId}.` });
        const done = (turnId: string, text = `Final ${turnId}.`) =>
          agent.receive({ type: "turn_done", role: "user", turnId, text });
        const delegate = (delegationId: string, userTurnId?: string, handoffId = delegationId) =>
          agent.receive({
            type: "delegation",
            delegationId,
            ...(userTurnId === undefined ? {} : { userTurnId }),
            handoffId,
            instructions: `Generated instruction for ${userTurnId}.`,
            provenance: "native_live_delegation",
          });
        if (scenario === "reordered") {
          yield* done("one", "Corrected final. Keep blue only; do not edit.");
          yield* created("one");
          yield* agent.receive({ type: "turn_delta", turnId: "one", text: " stale partial" });
          yield* delegate("one", "one");
          yield* done("one", "A late conflicting final cannot make new authority.");
          yield* delegate("corrected-late", "one");
        } else if (scenario === "interleaved") {
          yield* created("one");
          yield* delegate("one", "one");
          yield* created("two");
          yield* delegate("two", "two");
          yield* agent.receive({ type: "turn_delta", turnId: "one", text: " old parent only" });
          yield* done("one");
          expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
          yield* done("two", "Corrected final. Keep blue only; do not edit.");
          yield* done("greeting", "Hello.");
          yield* delegate("old-parent-new-id", "one");
          yield* delegate("old-completed-new-id", "two");
        } else if (scenario === "unassociated") {
          yield* done("one");
          yield* done("greeting", "Hello.");
          yield* delegate("missing");
          yield* delegate("unknown", "not-observed");
          yield* agent.receive({
            type: "turn_created",
            role: "assistant",
            turnId: "assistant",
            text: "Hi.",
          });
          yield* delegate("assistant", "assistant");
          yield* delegate("stale-first-delivery", "one");
        } else {
          yield* done("one");
          yield* delegate("one", "one", "shared-handoff");
          yield* done("two");
          yield* delegate("aliased-item", "two", "shared-handoff");
          yield* delegate("one", "two", "different-handoff");
          expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(1);
          yield* delegate("two", "two", "new-handoff");
        }
        const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
        expect(records.runs).toHaveLength(
          scenario === "unassociated" ? 0 : scenario === "handoff-replay" ? 2 : 1,
        );
        if (scenario === "reordered" || scenario === "interleaved") {
          const parent = scenario === "reordered" ? "one" : "two";
          const task = records.messages.find((message) => message.runId)!;
          expect(task.voice?.itemId).toBe(parent);
          expect(task.text).toBe("Corrected final. Keep blue only; do not edit.");
          expect(records.messages.find((message) => message.voice?.itemId === parent)?.text).toBe(
            "Corrected final. Keep blue only; do not edit.",
          );
        }
        if (scenario === "unassociated")
          for (const reason of ["missing_parent", "unknown_parent", "superseded_parent"])
            expect(notices.some((notice) => notice.text.includes(reason))).toBe(true);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect.each(["timeout", "stop", "disconnect", "capacity"] as const)(
  "%s drops bounded pending native work without creating task authority",
  (scenario) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`thread:pending-${scenario}`);
      yield* VoiceFixture.create(threadId);
      const threads = yield* ThreadManagement.ThreadManagementService;
      const notices: NativeLiveAppend[] = [];
      const agent = yield* Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* makeLiveAgentSession({
            binding: { threadId },
            sessionId: `pending-${scenario}`,
            onBound: () => {},
            send: () => Effect.void,
            append: (notice) =>
              Effect.sync(() => {
                notices.push(notice);
              }),
          });
          for (let index = 0; index < (scenario === "capacity" ? 33 : 1); index++) {
            yield* agent.receive({
              type: "turn_created",
              role: "user",
              turnId: `parent_${index}`,
              text: "Retain this correction.",
            });
            const pending = yield* agent
              .receive({
                type: "delegation",
                delegationId: `pending_${index}`,
                userTurnId: `parent_${index}`,
                handoffId: `handoff_${index}`,
                instructions: "Inspect blue without changes.",
                provenance: "native_live_delegation",
              })
              .pipe(Effect.result);
            expect(pending._tag).toBe(
              scenario === "capacity" && index === 32 ? "Failure" : "Success",
            );
          }
          expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
          if (scenario === "timeout") {
            yield* TestClock.adjust("30 seconds");
            // Expiry is checked on completion too, even without a timer poll.
            yield* agent.receive({
              type: "turn_done",
              role: "user",
              turnId: "parent_0",
              text: "Retain this correction.",
            });
            yield* agent.receive({
              type: "delegation",
              delegationId: "expired-replay",
              userTurnId: "parent_0",
              instructions: "Inspect blue.",
              provenance: "native_live_delegation",
            });
            expect(notices.some((notice) => notice.text.includes("parent_timeout"))).toBe(true);
          }
          if (scenario === "stop") {
            yield* agent.stop;
            yield* agent.receive({
              type: "turn_done",
              role: "user",
              turnId: "parent_0",
              text: "Retain this correction.",
            });
          }
          return agent;
        }),
      );
      yield* agent.receive({
        type: "turn_done",
        role: "user",
        turnId: "parent_0",
        text: "Late completion after disconnect.",
      });
      const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
      expect(records.runs).toHaveLength(0);
      expect(records.messages).toHaveLength(scenario === "capacity" ? 33 : 1);
      expect(records.messages.every((message) => message.voice?.itemId.startsWith("parent_"))).toBe(
        true,
      );
      expect(records.messages.every((message) => message.text === "Retain this correction.")).toBe(
        true,
      );
    }).pipe(Effect.provide(services)),
);

it.effect.each(["replay", "stop"] as const)(
  "%s during matching finalization retains one immutable parent receipt",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:parent-finalization-race");
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const guarded: typeof threads = {
          ...threads,
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type === "voice.message.record" && command.role === "user") {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return yield* threads.dispatch(command);
            }),
        };
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "parent-finalization-race",
          onBound: () => {},
          send: () => Effect.void,
          append: () => Effect.void,
        });
        yield* agent.receive({
          type: "turn_created",
          role: "user",
          turnId: "parent",
          text: "Inspect red",
        });
        const delegation = {
          type: "delegation",
          delegationId: "pending",
          handoffId: "handoff",
          userTurnId: "parent",
          instructions: "Inspect the fictional setting without changes.",
          provenance: "native_live_delegation",
        } as const;
        yield* agent.receive(delegation);
        const final = yield* agent
          .receive({
            type: "turn_done",
            role: "user",
            turnId: "parent",
            text: "Inspect blue, not red. Do not edit.",
          })
          .pipe(
            Effect.provideService(ThreadManagement.ThreadManagementService, guarded),
            Effect.forkScoped,
          );
        yield* Deferred.await(entered);
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          turnId: "parent",
          text: "Late correction must not create a new turn.",
        });
        yield* agent.receive({ ...delegation, delegationId: "alias" });
        yield* agent.receive({ ...delegation, delegationId: "second", handoffId: "other" });
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
        if (scenario === "stop") yield* agent.stop;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(final);
        const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
        expect(records.runs).toHaveLength(scenario === "stop" ? 0 : 1);
        expect(records.messages.filter((message) => message.voice)).toHaveLength(1);
        expect(records.messages.find((message) => message.voice)?.voice?.itemId).toBe("parent");
        expect(records.messages.find((message) => message.voice)?.text).toBe(
          "Inspect blue, not red. Do not edit.",
        );
        if (scenario === "replay")
          expect(records.messages.find((message) => message.runId)?.text).toContain(
            "Inspect blue, not red. Do not edit.",
          );
      }),
    ).pipe(Effect.provide(services)),
);

// R8 retained projection rows; identities and answer text are normalized in the fixture.
it.effect.each([
  "root result",
  "other thread",
  "other run",
  "generated voice",
  "stale attempt",
  "child turn",
  "unrelated node",
  "mismatched item thread",
  "mismatched item run",
  "child item",
  "wrong provider thread",
  "superseded turn",
])("captured canonical result association: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const {
        run,
        attempt,
        providerTurn: turn,
        typedFinal: item,
        finalMessage: message,
      } = decodeCapturedResult(resultCapture);
      const threadId = run.threadId;
      yield* VoiceFixture.create(threadId);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const base = { id: EventId.make("captured-result"), threadId, occurredAt: message.updatedAt };
      yield* store.apply({ ...base, type: "run.updated", payload: { ...run, status: "running" } });
      yield* store.apply({ ...base, type: "run-attempt.updated", payload: attempt });
      yield* store.apply({
        ...base,
        type: "provider-turn.updated",
        payload: {
          ...turn,
          ...(scenario === "stale attempt"
            ? { runAttemptId: RunAttemptId.make("stale-attempt") }
            : {}),
          ...(scenario === "child turn" ? { nodeId: NodeId.make("child-root") } : {}),
          ...(scenario === "wrong provider thread"
            ? { providerThreadId: ProviderThreadId.make("parallel-provider-thread") }
            : {}),
        },
      });
      if (scenario === "superseded turn")
        yield* store.apply({
          ...base,
          type: "provider-turn.updated",
          payload: { ...turn, id: ProviderTurnId.make("newer-turn"), ordinal: turn.ordinal + 1 },
        });
      const appends: NativeLiveAppend[] = [];
      const agent = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "captured-result-session",
        onBound: () => {},
        send: () => Effect.void,
        append: (event) =>
          Effect.sync(() => {
            appends.push(event);
          }),
      });
      yield* agent.seed;
      expect(appends.every((event) => !event.text.includes("actualAgentResult"))).toBe(true);
      yield* store.apply({
        ...base,
        type: "message.updated",
        payload: {
          ...message,
          ...(scenario === "other thread" ? { threadId: ThreadId.make("other-thread") } : {}),
          ...(scenario === "other run" ? { runId: RunId.make("other-run") } : {}),
          ...(scenario === "unrelated node" ? { nodeId: NodeId.make("unrelated-node") } : {}),
          ...(scenario === "generated voice"
            ? { voice: { ...VoiceFixture.voice, textKind: "generated_voice_reply" as const } }
            : {}),
        },
      });
      yield* store.apply({
        ...base,
        type: "turn-item.updated",
        payload: {
          ...item,
          ...(scenario === "mismatched item thread"
            ? { threadId: ThreadId.make("other-thread") }
            : {}),
          ...(scenario === "mismatched item run" ? { runId: RunId.make("other-run") } : {}),
          ...(scenario === "child item" ? { parentItemId: TurnItemId.make("parent-item") } : {}),
        },
      });
      yield* store.apply({ ...base, type: "run.updated", payload: run });
      yield* agent.poll;
      yield* agent.poll;
      const results = appends.filter((event) => event.text.includes("actualAgentResult"));
      if (scenario === "root result") {
        expect(results).toHaveLength(1);
        expect(JSON.parse(results[0]!.text)).toMatchObject({
          runId: run.id,
          status: "completed",
          actualAgentResult: message.text,
          sourceMessageIds: [message.id],
        });
        yield* agent.receive({
          type: "turn_done",
          role: "assistant",
          turnId: "narrated-result",
          text: message.text,
        });
        yield* agent.receive({
          type: "delegation",
          delegationId: "cyclic-refeed",
          userTurnId: "narrated-result",
          instructions: message.text,
          provenance: "native_live_delegation",
        });
        yield* agent.poll;
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(1);
        expect(appends.filter((event) => event.text.includes("actualAgentResult"))).toHaveLength(1);
        const replacement = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "replacement-result-session",
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.sync(() => {
              appends.push(event);
            }),
        });
        yield* replacement.seed;
        yield* replacement.poll;
        expect(appends.filter((event) => event.text.includes("actualAgentResult"))).toHaveLength(1);
      } else {
        expect(results).toHaveLength(0);
      }
    }),
  ).pipe(Effect.provide(services)),
);

it.effect.each([1, 4])("result snapshots stay constant per poll with %s tracked runs", (count) =>
  Effect.scoped(
    Effect.gen(function* () {
      const captured = decodeCapturedResult(resultCapture);
      const typedFinal = captured.typedFinal;
      if (typedFinal.type !== "assistant_message")
        throw new Error("Expected captured assistant item.");
      const threadId = captured.run.threadId;
      yield* VoiceFixture.create(threadId);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const base = {
        id: EventId.make("batched-result"),
        threadId,
        occurredAt: captured.finalMessage.updatedAt,
      };
      const entries = Array.from({ length: count }, (_, index) => {
        const runId = RunId.make(`batched-run-${index}`);
        const attemptId = RunAttemptId.make(`batched-attempt-${index}`);
        const turnId = ProviderTurnId.make(`batched-turn-${index}`);
        const nodeId = NodeId.make(`batched-message-node-${index}`);
        const messageId = MessageId.make(`batched-message-${index}`);
        const rootNodeId = NodeId.make(`batched-root-${index}`);
        const providerThreadId = ProviderThreadId.make(`batched-provider-thread-${index}`);
        return {
          run: {
            ...captured.run,
            id: runId,
            ordinal: index + 1,
            activeAttemptId: attemptId,
            rootNodeId,
            providerThreadId,
          },
          attempt: { ...captured.attempt, id: attemptId, runId, rootNodeId, providerThreadId },
          turn: {
            ...captured.providerTurn,
            id: turnId,
            runAttemptId: attemptId,
            nodeId: rootNodeId,
            providerThreadId,
          },
          item: {
            ...typedFinal,
            id: TurnItemId.make(`batched-item-${index}`),
            runId,
            nodeId,
            messageId,
            providerTurnId: turnId,
            providerThreadId,
            ordinal: captured.typedFinal.ordinal + index,
          },
          message: {
            ...captured.finalMessage,
            id: messageId,
            runId,
            nodeId,
            text: `Authored result ${index}.`,
          },
        };
      });
      for (const entry of entries) {
        yield* store.apply({
          ...base,
          type: "run.updated",
          payload: { ...entry.run, status: "running" },
        });
        yield* store.apply({ ...base, type: "run-attempt.updated", payload: entry.attempt });
        yield* store.apply({ ...base, type: "provider-turn.updated", payload: entry.turn });
        yield* store.apply({
          ...base,
          type: "message.updated",
          payload: { ...entry.message, streaming: true },
        });
        yield* store.apply({
          ...base,
          type: "turn-item.updated",
          payload: { ...entry.item, streaming: true },
        });
      }
      const appends: NativeLiveAppend[] = [];
      const agent = yield* makeLiveAgentSession({
        binding: { threadId },
        sessionId: "batched-result-session",
        onBound: () => {},
        send: () => Effect.void,
        append: (event) =>
          Effect.sync(() => {
            appends.push(event);
          }),
      });
      yield* agent.seed;
      const lookups = vi.spyOn(store, "getThreadRecords");
      yield* Effect.addFinalizer(() => Effect.sync(() => lookups.mockRestore()));
      yield* agent.poll;
      expect(lookups).toHaveBeenCalledTimes(2);
      expect(
        lookups.mock.calls.find(([, fields]) => fields.includes("attempts"))?.[2],
      ).toMatchObject({
        messageRunIds: entries.map((entry) => entry.run.id),
        messageRoles: ["assistant"],
        turnItemRunIds: entries.map((entry) => entry.run.id),
        turnItemTypes: ["assistant_message"],
      });
      expect(lookups.mock.calls.filter(([, fields]) => fields.includes("attempts"))).toHaveLength(
        1,
      );
      expect(
        lookups.mock.calls.filter(([, fields]) => fields.includes("providerTurns")),
      ).toHaveLength(1);
      expect(appends.filter((event) => event.text.includes("actualAgentResult"))).toHaveLength(0);
      lookups.mockClear();
      for (const entry of entries) {
        const attemptId = RunAttemptId.make(`${entry.attempt.id}-fresh`);
        const turnId = ProviderTurnId.make(`${entry.turn.id}-fresh`);
        yield* store.apply({
          ...base,
          type: "run-attempt.updated",
          payload: {
            ...entry.attempt,
            id: attemptId,
            attemptOrdinal: entry.attempt.attemptOrdinal + 1,
          },
        });
        yield* store.apply({
          ...base,
          type: "provider-turn.updated",
          payload: {
            ...entry.turn,
            id: turnId,
            runAttemptId: attemptId,
            ordinal: entry.turn.ordinal + 1,
          },
        });
        yield* store.apply({ ...base, type: "message.updated", payload: entry.message });
        yield* store.apply({
          ...base,
          type: "turn-item.updated",
          payload: { ...entry.item, providerTurnId: turnId },
        });
        yield* store.apply({
          ...base,
          type: "run.updated",
          payload: { ...entry.run, activeAttemptId: attemptId },
        });
      }
      yield* agent.poll;
      expect(lookups).toHaveBeenCalledTimes(2);
      expect(lookups.mock.calls.filter(([, fields]) => fields.includes("attempts"))).toHaveLength(
        1,
      );
      expect(
        lookups.mock.calls.filter(([, fields]) => fields.includes("providerTurns")),
      ).toHaveLength(1);
      expect(
        appends
          .filter((event) => event.text.includes("actualAgentResult"))
          .map((event) => JSON.parse(event.text)),
      ).toEqual(
        expect.arrayContaining(
          entries.map((entry) =>
            expect.objectContaining({
              runId: entry.run.id,
              status: "completed",
              actualAgentResult: entry.message.text,
              sourceMessageIds: [entry.message.id],
            }),
          ),
        ),
      );
      lookups.mockClear();
      yield* agent.poll;
      expect(lookups).toHaveBeenCalledTimes(2);
      expect(appends.filter((event) => event.text.includes("actualAgentResult"))).toHaveLength(
        count,
      );
    }),
  ).pipe(Effect.provide(services)),
);

it.effect(
  "resumes a result completed during outage once, without executing or approving work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { run, attempt, providerTurn, typedFinal, finalMessage } =
          decodeCapturedResult(resultCapture);
        const threadId = run.threadId;
        yield* VoiceFixture.create(threadId);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const base = {
          id: EventId.make("outage-result"),
          threadId,
          occurredAt: finalMessage.updatedAt,
        };
        yield* store.apply({ ...base, type: "run.updated", payload: run });
        yield* store.apply({ ...base, type: "run-attempt.updated", payload: attempt });
        yield* store.apply({ ...base, type: "provider-turn.updated", payload: providerTurn });
        yield* store.apply({ ...base, type: "message.updated", payload: finalMessage });
        yield* store.apply({ ...base, type: "turn-item.updated", payload: typedFinal });
        const appends: NativeLiveAppend[] = [];
        const delivered: LiveVoiceServerEvent[] = [];
        const make = (resumeRunIds: RunId[]) =>
          makeLiveAgentSession({
            binding: { threadId, resumeRunIds },
            sessionId: "outage",
            onBound: () => {},
            send: (event) =>
              Effect.sync(() => {
                delivered.push(event);
              }),
            append: (event) =>
              Effect.sync(() => {
                appends.push(event);
              }),
          });
        const disconnected = yield* make([run.id]);
        yield* disconnected.seed;
        yield* disconnected.receive({
          type: "turn_created",
          role: "user",
          turnId: "outage-speech",
          text: "Keep",
        });
        yield* disconnected.poll;
        expect(appends.filter((event) => event.text.includes("actualAgentResult"))).toHaveLength(0);
        yield* disconnected.stop;
        const resumed = yield* make([run.id]);
        yield* resumed.seed;
        yield* resumed.poll;
        yield* resumed.poll;
        expect(appends.filter((event) => event.text.includes("actualAgentResult"))).toHaveLength(1);
        expect(
          delivered.filter((event) => event.type === "live.agent" && event.status === "completed"),
        ).toHaveLength(1);
        const next = yield* make([]);
        yield* next.seed;
        yield* next.poll;
        expect(appends.filter((event) => event.text.includes("actualAgentResult"))).toHaveLength(1);
        const records = yield* threads.getThreadRecords(threadId, ["runs", "runtimeRequests"]);
        expect(records.runs).toHaveLength(1);
        expect(records.runtimeRequests).toHaveLength(0);
        const foreignThread = ThreadId.make("foreign-thread");
        const foreignRun = RunId.make("foreign-run");
        yield* VoiceFixture.create(foreignThread);
        yield* store.apply({
          ...base,
          threadId: foreignThread,
          type: "run.updated",
          payload: { ...run, id: foreignRun, threadId: foreignThread },
        });
        const invalid = yield* make([foreignRun]);
        const rejected = yield* invalid.seed.pipe(Effect.result);
        expect(rejected._tag).toBe("Failure");
        expect(appends.filter((event) => event.text.includes("actualAgentResult"))).toHaveLength(1);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect.each([false, true])(
  "task context follows revisions during user and assistant speech without authorizing speech (conflict: %s)",
  (conflict) =>
    Effect.scoped(
      Effect.gen(function* () {
        const captured = decodeCapturedResult(resultCapture);
        const item = captured.typedFinal;
        if (item.type !== "assistant_message") throw new Error("Expected assistant item");
        const threadId = captured.run.threadId;
        yield* VoiceFixture.create(threadId);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const base = {
          id: EventId.make("duplex-context"),
          threadId,
          occurredAt: captured.finalMessage.updatedAt,
        };
        const update = (
          text: string,
          streaming: boolean,
          status: "running" | "completed",
          at: number,
          itemAt = at,
        ) =>
          Effect.gen(function* () {
            yield* store.apply({
              ...base,
              type: "run.updated",
              payload: { ...captured.run, status },
            });
            yield* store.apply({ ...base, type: "run-attempt.updated", payload: captured.attempt });
            yield* store.apply({
              ...base,
              type: "provider-turn.updated",
              payload: captured.providerTurn,
            });
            yield* store.apply({
              ...base,
              type: "message.updated",
              payload: {
                ...captured.finalMessage,
                text,
                streaming,
                updatedAt: DateTime.makeUnsafe(at),
              },
            });
            yield* store.apply({
              ...base,
              type: "turn-item.updated",
              payload: {
                ...item,
                text,
                streaming,
                updatedAt: DateTime.makeUnsafe(itemAt),
              },
            });
          });
        yield* update("Initial output", false, "running", 1000);
        const appends: NativeLiveAppend[] = [];
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "duplex-context",
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.sync(() => {
              appends.push(event);
            }),
        });
        yield* agent.seed;
        yield* agent.receive({
          type: "turn_created",
          role: "user",
          turnId: "answer",
          text: "I can see",
        });
        yield* update("Which branch?", true, "running", 2000, 5000);
        yield* agent.poll;
        yield* agent.poll;
        const context = () =>
          appends.filter((e) => JSON.parse(e.text).source === "T3_task_context");
        expect(context()).toHaveLength(1);
        expect(context()[0]?.channel).toBe("quiet");
        expect(context()[0]?.text).toContain("Which branch?");
        yield* update("Which branch should I use?", false, "running", 3000, 5000);
        yield* agent.poll;
        expect(context()).toHaveLength(2);
        // The item clock stays newer while message revisions reorder independently.
        yield* update("Which branch?", true, "running", 2000, 5000);
        yield* agent.poll;
        expect(context()).toHaveLength(2);
        yield* update("An unordered equal-clock replacement", false, "running", 3000, 6000);
        yield* agent.poll;
        expect(context()).toHaveLength(2);
        yield* update("A newer message with an older item", true, "running", 4000, 4000);
        yield* agent.poll;
        expect(context()).toHaveLength(2);
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          turnId: "answer",
          text: "Use the feature branch.",
        });
        yield* agent.receive({
          type: "turn_created",
          role: "assistant",
          turnId: "reply",
          text: "Understood",
        });
        yield* update(
          conflict ? "Conflicting final B" : "Done on the feature branch.",
          false,
          "completed",
          conflict ? 3000 : 4000,
          6000,
        );
        yield* agent.poll;
        expect(context()).toHaveLength(conflict ? 2 : 3);
        expect(appends.filter((e) => e.channel === "speakable")).toHaveLength(0);
        yield* agent.receive({
          type: "turn_done",
          role: "assistant",
          turnId: "reply",
          text: "Understood.",
        });
        yield* agent.poll;
        yield* agent.poll;
        const offers = appends.filter((e) => e.channel === "speakable");
        expect(offers).toHaveLength(1);
        const offered = JSON.parse(offers[0]!.text);
        expect(offered.resultId).toBe(JSON.parse(context()[0]!.text).resultId);
        if (conflict) {
          expect(offered.actualAgentResult).toBeUndefined();
          expect(offered.resultUnavailableReason).toBe("conflicting_revisions");
          expect(offered.note).toContain("written T3 result");
        } else {
          expect(offered.sourceRevisions).toEqual(
            JSON.parse(context().at(-1)!.text).sourceRevisions,
          );
        }
        yield* agent.poll;
        expect(appends.filter((event) => event.channel === "speakable")).toHaveLength(1);
        yield* agent.stop;
        yield* update("Late callback", false, "completed", 5000);
        yield* agent.poll;
        expect(context()).toHaveLength(conflict ? 2 : 3);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect(
  "history hydration is returned for bootstrap and never appended as a fresh speech event",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:bootstrap-history");
        yield* VoiceFixture.create(threadId);
        const appends: NativeLiveAppend[] = [];
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "bootstrap-history",
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.sync(() => {
              appends.push(event);
            }),
        });
        const history = yield* agent.seed;
        expect(history).toContain("T3_bound_history");
        yield* agent.seed;
        yield* agent.poll;
        expect(appends).toHaveLength(0);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect.each([false, true])(
  "reconnect result offers stay bounded after ambiguous write: %s",
  (ambiguous) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { run, attempt, providerTurn, typedFinal, finalMessage } =
          decodeCapturedResult(resultCapture);
        const threadId = run.threadId;
        yield* VoiceFixture.create(threadId);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const base = {
          id: EventId.make("bounded-recovery"),
          threadId,
          occurredAt: finalMessage.updatedAt,
        };
        yield* store.apply({ ...base, type: "run.updated", payload: run });
        yield* store.apply({ ...base, type: "run-attempt.updated", payload: attempt });
        yield* store.apply({ ...base, type: "provider-turn.updated", payload: providerTurn });
        yield* store.apply({ ...base, type: "message.updated", payload: finalMessage });
        yield* store.apply({ ...base, type: "turn-item.updated", payload: typedFinal });
        const offers = new Map<string, import("./liveAgentSession.ts").LiveResultOffer>();
        let writes = 0;
        for (let index = 0; index < 4; index++) {
          const agent = yield* makeLiveAgentSession({
            binding: { threadId, resumeRunIds: [run.id] },
            sessionId: `recovery-${index}`,
            resultOffers: offers,
            onBound: () => {},
            send: () => Effect.void,
            append: (event) =>
              Effect.gen(function* () {
                if (event.channel !== "speakable") return;
                writes++;
                if (ambiguous) return yield* new LiveConnectionError({ reason: "disconnected" });
              }),
          });
          yield* agent.seed;
          yield* agent.poll.pipe(Effect.result);
          yield* agent.stop;
        }
        expect(writes).toBe(ambiguous ? 2 : 1);
        // Another authenticated listener has independent announcement authority.
        const listener = yield* makeLiveAgentSession({
          binding: { threadId, resumeRunIds: [run.id] },
          sessionId: "other-listener",
          resultOffers: new Map(),
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.sync(() => {
              if (event.channel === "speakable") writes++;
            }),
        });
        yield* listener.seed;
        yield* listener.poll;
        expect(writes).toBe(ambiguous ? 3 : 2);
        const threads = yield* ThreadManagement.ThreadManagementService;
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(1);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect(
  "quiet streaming context is bounded and yields between batches without losing revisions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captured = decodeCapturedResult(resultCapture);
        const threadId = captured.run.threadId;
        yield* VoiceFixture.create(threadId);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const base = {
          id: EventId.make("context-batch"),
          threadId,
          occurredAt: captured.finalMessage.updatedAt,
        };
        yield* store.apply({
          ...base,
          type: "run.updated",
          payload: { ...captured.run, status: "running" },
        });
        // Legacy root messages need no provider turn; each still has canonical thread/run/node ownership.
        const update = (index: number, text: string, at: number, streaming = true) =>
          store.apply({
            ...base,
            type: "message.updated",
            payload: {
              ...captured.finalMessage,
              id: MessageId.make(`batch-${index}`),
              nodeId: captured.run.rootNodeId,
              text,
              streaming,
              updatedAt: DateTime.makeUnsafe(at),
            },
          });
        const otherRun = {
          ...captured.run,
          id: RunId.make("fair-other-run"),
          ordinal: 2,
          rootNodeId: NodeId.make("fair-other-root"),
          status: "running" as const,
        };
        yield* store.apply({ ...base, type: "run.updated", payload: otherRun });
        yield* store.apply({
          ...base,
          type: "message.updated",
          payload: {
            ...captured.finalMessage,
            id: MessageId.make("fair-other-question"),
            runId: otherRun.id,
            nodeId: otherRun.rootNodeId,
            text: "Which environment?",
            streaming: true,
            updatedAt: DateTime.makeUnsafe(1000),
          },
        });
        const appends: NativeLiveAppend[] = [];
        const events: LiveVoiceServerEvent[] = [];
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "context-batch",
          onBound: () => {},
          send: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          append: (event) =>
            Effect.sync(() => {
              encodeNativeLiveAppend(event);
              appends.push(event);
            }),
        });
        yield* agent.seed;
        for (let index = 0; index < 12; index++)
          yield* update(index, index === 11 ? "界".repeat(20000) : "Which", 1000);
        const context = () =>
          appends.filter((e) => JSON.parse(e.text).source === "T3_task_context");
        yield* agent.poll;
        expect(context()).toHaveLength(8);
        yield* agent.receive({
          type: "turn_created",
          role: "user",
          turnId: "batch-answer",
          text: "Use blue",
        });
        expect(events.some((e) => e.type === "live.caption" && e.text === "Use blue")).toBe(true);
        for (let index = 0; index < 8; index++) yield* update(index, "Which changed?", 1500);
        yield* agent.poll;
        expect(
          context().some((event) => JSON.parse(event.text).messageId === "fair-other-question"),
        ).toBe(true);
        expect(context().some((event) => JSON.parse(event.text).messageId === "batch-9")).toBe(
          true,
        );
        yield* agent.poll;
        expect(context().some((event) => JSON.parse(event.text).messageId === "batch-11")).toBe(
          true,
        );
        expect(
          context().every((e) => e.channel === "quiet" && Buffer.byteLength(e.text) <= 4096),
        ).toBe(true);
        const oversized = context()
          .map((event) => JSON.parse(event.text))
          .find((event) => event.messageId === "batch-11");
        expect(oversized.actualAgentOutput).toBeUndefined();
        expect(oversized.actualAgentExcerpt).toBe("界".repeat(256));
        const predecessor = context()
          .map((event) => JSON.parse(event.text))
          .findLast((event) => event.messageId === "batch-0");
        yield* update(0, "Which changed? branch?", 2000);
        yield* agent.poll;
        expect(JSON.parse(context().at(-1)!.text)).toMatchObject({
          operation: "append",
          outputDelta: " branch?",
          fromVersion: predecessor.version,
        });
        const delivered = JSON.parse(context().at(-1)!.text);
        yield* update(0, "Which changed? branch? Again", 2000);
        yield* agent.poll;
        expect(JSON.parse(context().at(-1)!.text)).toMatchObject({
          fromVersion: delivered.version,
          version: delivered.version + 1,
          outputDelta: " Again",
        });
        const beforeAmbiguous = context().length;
        yield* update(0, "An unordered replacement at the same timestamp", 2000);
        yield* agent.poll;
        expect(context()).toHaveLength(beforeAmbiguous);
        yield* update(0, "Corrected final text", 2000, false);
        yield* agent.poll;
        expect(JSON.parse(context().at(-1)!.text)).toMatchObject({
          operation: "replace",
          actualAgentOutput: "Corrected final text",
          streaming: false,
        });
        const beforeReplay = context().length;
        yield* update(0, "Corrected final text plus stale streaming", 2000);
        yield* agent.poll;
        expect(context()).toHaveLength(beforeReplay);
        const deliveredCount = context().length;
        yield* agent.poll;
        expect(context()).toHaveLength(deliveredCount);
        expect(appends.filter((e) => e.channel === "speakable")).toHaveLength(0);
        yield* store.apply({
          ...base,
          type: "message.updated",
          payload: {
            ...captured.finalMessage,
            id: MessageId.make("fair-other-question"),
            runId: otherRun.id,
            nodeId: otherRun.rootNodeId,
            text: "Which environment?",
            streaming: false,
            updatedAt: DateTime.makeUnsafe(3000),
          },
        });
        yield* store.apply({
          ...base,
          type: "run.updated",
          payload: { ...otherRun, status: "completed" },
        });
        for (let poll = 0; poll < 2; poll++) {
          for (let index = 0; index < 8; index++)
            yield* update(index, `Hot output ${poll}`, 4000 + poll);
          yield* agent.poll;
        }
        expect(appends.filter((event) => event.channel === "speakable")).toHaveLength(0);
        yield* agent.receive({
          type: "turn_done",
          role: "user",
          turnId: "batch-answer",
          text: "Use blue",
        });
        yield* agent.receive({
          type: "turn_created",
          role: "assistant",
          turnId: "batch-reply",
          text: "Understood",
        });
        yield* agent.poll;
        expect(appends.filter((event) => event.channel === "speakable")).toHaveLength(0);
        yield* agent.receive({
          type: "turn_done",
          role: "assistant",
          turnId: "batch-reply",
          text: "Understood.",
        });
        yield* agent.poll;
        expect(
          appends
            .filter((event) => event.channel === "speakable")
            .map((event) => JSON.parse(event.text)),
        ).toEqual([
          expect.objectContaining({ runId: otherRun.id, actualAgentResult: "Which environment?" }),
        ]);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect.each([false, true])(
  "attention survives reconnect before an offer and clears after run retirement (ambiguous: %s)",
  (ambiguous) =>
    Effect.scoped(
      Effect.gen(function* () {
        const captured = decodeCapturedResult(resultCapture);
        const rootNodeId = captured.run.rootNodeId;
        if (!rootNodeId) throw new Error("Expected root node");
        const threadId = captured.run.threadId;
        yield* VoiceFixture.create(threadId);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const base = {
          id: EventId.make("attention-recovery"),
          threadId,
          occurredAt: captured.finalMessage.updatedAt,
        };
        yield* store.apply({
          ...base,
          type: "run.updated",
          payload: { ...captured.run, status: "running" },
        });
        const request: OrchestrationV2RuntimeRequest = {
          id: RuntimeRequestId.make("new-attention"),
          nodeId: rootNodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: DateTime.makeUnsafe(0),
          resolvedAt: null,
        };
        const offers = new Map<string, import("./liveAgentSession.ts").LiveResultOffer>();
        const appends: NativeLiveAppend[] = [];
        const first = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "attention-before-disconnect",
          resultOffers: offers,
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.gen(function* () {
              appends.push(event);
              if (ambiguous && event.channel === "speakable")
                return yield* new LiveConnectionError({ reason: "disconnected" });
            }),
        });
        yield* first.seed;
        yield* store.apply({ ...base, type: "runtime-request.updated", payload: request });
        if (!ambiguous)
          yield* first.receive({
            type: "turn_created",
            role: "user",
            turnId: "busy-human",
            text: "Wait",
          });
        yield* first.poll.pipe(Effect.result);
        yield* first.stop;
        const second = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "attention-after-disconnect",
          resultOffers: offers,
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.sync(() => {
              appends.push(event);
            }),
        });
        yield* second.seed;
        yield* second.poll;
        yield* second.poll;
        const essential = () =>
          appends.filter(
            (event) =>
              event.channel === "speakable" &&
              JSON.parse(event.text).status === "waiting_for_user_in_T3",
          );
        expect(essential()).toHaveLength(ambiguous ? 2 : 1);
        yield* store.apply({ ...base, type: "run.updated", payload: captured.run });
        yield* second.poll;
        const terminalOffer = appends.find(
          (event) => event.channel === "speakable" && JSON.parse(event.text).status === "completed",
        );
        expect(JSON.parse(terminalOffer!.text)).toMatchObject({
          pendingRequests: [{ id: request.id, kind: request.kind, status: "pending" }],
          pendingRequestCaveat: expect.stringContaining("not submitted"),
        });
        yield* second.receive({
          type: "turn_created",
          role: "user",
          turnId: "resolving-human",
          text: "I handled it",
        });
        yield* store.apply({
          ...base,
          type: "runtime-request.updated",
          payload: { ...request, status: "resolved", resolvedAt: DateTime.makeUnsafe(2000) },
        });
        yield* second.poll;
        expect(
          appends
            .filter((event) => JSON.parse(event.text).source === "T3_attention_context")
            .map((event) => JSON.parse(event.text).pendingRequests)
            .at(-1),
        ).toEqual([]);
        expect(essential()).toHaveLength(ambiguous ? 2 : 1);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect.each(["empty", "nonempty", "wrong-project"] as const)(
  "reserved draft cannot bypass launch validation: %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const reserved = ThreadId.make("reserved-live-draft");
        yield* VoiceFixture.create(reserved);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const shell = (yield* threads.getThreadShell(reserved))!;
        if (mode === "nonempty")
          yield* threads.sendToThread({
            projectId: VoiceFixture.projectId,
            threadId: reserved,
            commandId: CommandId.make("reserved-typed-wins"),
            messageId: MessageId.make("reserved-typed-wins"),
            text: "Typed input wins",
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          });
        const events: LiveVoiceServerEvent[] = [];
        const calls: ThreadLaunch.ThreadLaunchInput[] = [];
        const agent = yield* makeLiveAgentSession({
          binding: {
            draft: {
              threadId: reserved,
              projectId:
                mode === "wrong-project"
                  ? ProjectId.make("foreign-project")
                  : VoiceFixture.projectId,
              modelSelection: shell.modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          },
          sessionId: `reserved-${mode}`,
          onBound: () => {},
          send: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          append: () => Effect.void,
        }).pipe(
          Effect.provide(
            Layer.mock(ThreadLaunch.ThreadLaunchService)({
              launch: (input) =>
                Effect.gen(function* () {
                  calls.push(input);
                  if (mode !== "empty")
                    return yield* new ThreadLaunch.ThreadLaunchError({
                      operation: "update-thread",
                      commandId: input.commandId,
                      projectId: input.projectId,
                      cause: "Existing launch validation rejects this shell",
                    });
                  return {
                    threadId: reserved,
                    projection: yield* threads.getThreadProjection(reserved).pipe(Effect.orDie),
                    resumed: true,
                  };
                }),
            }),
          ),
        );
        const result = yield* agent.bind.pipe(Effect.result);
        expect(result._tag).toBe(mode === "empty" ? "Success" : "Failure");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          threadId: reserved,
          projectId:
            mode === "wrong-project" ? ProjectId.make("foreign-project") : VoiceFixture.projectId,
          reuseExistingThread: true,
        });
        expect(events.filter((event) => event.type === "live.bound")).toHaveLength(
          mode === "empty" ? 1 : 0,
        );
        expect(agent.getThreadId()).toBe(mode === "empty" ? reserved : undefined);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect.each(["collision", "stop"] as const)(
  "reserved draft retains one durable identity during %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const reference = ThreadId.make("draft-model-reference");
        const reserved = ThreadId.make("reserved-draft-race");
        yield* VoiceFixture.create(reference);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const modelSelection = (yield* threads.getThreadShell(reference))!.modelSelection;
        const events: LiveVoiceServerEvent[] = [];
        let calls = 0;
        let stop = Effect.void;
        const agent = yield* makeLiveAgentSession({
          binding: {
            draft: {
              threadId: reserved,
              projectId: VoiceFixture.projectId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          },
          sessionId: `reserved-race-${mode}`,
          onBound: () => {},
          send: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          append: () => Effect.void,
        }).pipe(
          Effect.provide(
            Layer.mock(ThreadLaunch.ThreadLaunchService)({
              launch: (input) =>
                Effect.gen(function* () {
                  calls++;
                  expect(input.threadId).toBe(reserved);
                  if (calls === 1) {
                    yield* VoiceFixture.create(reserved).pipe(
                      Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
                      Effect.orDie,
                    );
                    if (mode === "collision")
                      return yield* new ThreadLaunch.ThreadLaunchError({
                        operation: "create-thread",
                        commandId: input.commandId,
                        projectId: input.projectId,
                        cause: "Typed shell won create race",
                      });
                    yield* stop;
                  } else expect(input.reuseExistingThread).toBe(true);
                  return {
                    threadId: reserved,
                    projection: yield* threads.getThreadProjection(reserved).pipe(Effect.orDie),
                    resumed: calls > 1,
                  };
                }),
            }),
          ),
        );
        stop = agent.stop;
        yield* agent.bind;
        expect(calls).toBe(mode === "collision" ? 2 : 1);
        expect(agent.getThreadId()).toBe(reserved);
        expect(events.filter((event) => event.type === "live.bound")).toHaveLength(
          mode === "collision" ? 1 : 0,
        );
        const records = yield* threads.getThreadRecords(reserved, ["runs", "messages"]);
        expect(records.thread.id).toBe(reserved);
        expect(records.runs).toHaveLength(0);
        expect(records.messages).toHaveLength(0);
      }),
    ).pipe(Effect.provide(services)),
);
