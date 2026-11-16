import { expect, it } from "@effect/vitest";
import {
  CommandId,
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
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as VoiceFixture from "../orchestration-v2/VoiceConversation.testkit.ts";
import { sendRecordedVoiceMessage } from "../orchestration-v2/VoiceConversation.ts";
import { makeLiveAgentSession } from "./liveAgentSession.ts";
import { decodeNativeLiveEvent, type NativeLiveAppend } from "./liveProtocol.ts";
import parentCapture from "./fixtures/live-native/parent-association.json" with { type: "json" };

const services = Layer.mergeAll(
  VoiceFixture.layer,
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/fixture/projects",
  }),
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
            (message) => message.runId && message.text.includes(`"userTurnId":"turn_${name}"`),
          );
          expect(submitted?.text).toContain(speech!.text.trim());
          expect(submitted?.createdBy).toBe("agent");
        }
        expect(records.messages.filter((message) => message.voice)).toHaveLength(4);
      }),
    ).pipe(Effect.provide(services)),
);

it.live(
  "direct conversation is canonical history only; derived delegation enters ONE normal run without relabeling speech",
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
        const blocked = yield* sendRecordedVoiceMessage({
          projectId: VoiceFixture.projectId,
          threadId,
          sessionId: "fictional-session",
          messageId: speech.id,
        }).pipe(Effect.result);
        expect(blocked._tag).toBe("Failure"); // application-frozen text never acquires original-speech task authority
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
        expect(submitted.createdBy).toBe("agent");
        expect(submitted.creationSource).toBe("server");
        expect(submitted.voice).toBeUndefined();
        expect(submitted.text).toContain("NOT a verbatim human quotation");
        expect(submitted.text).toContain('"source":"native_live_delegation"');
        expect(submitted.text).toContain(delegation.instructions);
        expect(after.messages.find((message) => message.id === speech.id)?.text).toBe(speech.text);
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
        yield* replacement.seed;
        expect(replay[0]?.text).toContain("The kite is blue, not red. Do not change files.");
        expect(replay[0]?.text).toContain("T3_bound_history");
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
          message.voice.delivery === "unknown",
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === "live.caption" && event.committed)).toHaveLength(
      2,
    );
  }).pipe(Effect.provide(services)),
);

it.live("a derived spoken yes cannot bypass pending T3 permissions or questions", () =>
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
        kind: "command",
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
            notices.push(event);
          }),
      }).pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ...threads,
          getThreadRecords: (...args) =>
            threads
              .getThreadRecords(...args)
              .pipe(Effect.map((records) => ({ ...records, runtimeRequests: [pending] }))),
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
    }),
  ).pipe(Effect.provide(services)),
);

it.live(
  "speakable completion is grounded in an authored result, not generated voice or acceptance",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:live-grounded-result");
        yield* VoiceFixture.create(threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        let final: OrchestrationV2ConversationMessage | undefined;
        const appends: NativeLiveAppend[] = [];
        const agent = yield* makeLiveAgentSession({
          binding: { threadId },
          sessionId: "fictional-result-session",
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.sync(() => {
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
          text: "Inspect the fictional configuration without changes.",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        yield* agent.poll;
        expect(appends.every((event) => !event.text.includes("actualAgentResult"))).toBe(true);
        final = {
          ...sent.message,
          id: MessageId.make("fictional-authored-final"),
          runId: sent.run.id,
          role: "assistant",
          createdBy: "agent",
          creationSource: "server",
          text: "Inspected the fictional configuration. No files were changed.",
        };
        yield* agent.poll;
        yield* agent.poll;
        const results = appends.filter((event) => event.text.includes("actualAgentResult"));
        expect(results).toHaveLength(1);
        expect(results[0]?.text).toContain(final.text);
        expect(results[0]?.text).toContain(final.id);
        expect(results[0]?.text).not.toContain("UNVERIFIED VOICE CLAIM");
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

it.effect(
  "inactivity freezes assistant history without finalizing human authority; completion and Stop do not duplicate history",
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
            1,
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
        "Initial assistant.",
        "Initial user.",
        "Corrected user.",
        "Corrected assistant.",
      ]);
      expect(
        records.messages.every(
          (message) => message.voice?.transcriptFinality === "application_frozen",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(services)),
);

it.effect(
  "progress expires and coalesces globally without suppressing canonical terminal results",
  () =>
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
          onBound: () => {},
          send: () => Effect.void,
          append: (event) =>
            Effect.sync(() => {
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
                      id: MessageId.make(`commentary-${index}`),
                      runId: run.id,
                      role: "assistant" as const,
                      createdBy: "agent" as const,
                      text: `Grounded commentary ${index}.`,
                      createdAt: timestamp,
                      updatedAt: timestamp,
                    })),
                  ],
                  turnItems: sent.map(({ run }, index): OrchestrationV2TurnItem => ({
                    id: TurnItemId.make(`commentary-item-${index}`),
                    threadId,
                    runId: run.id,
                    nodeId: null,
                    ordinal: index,
                    type: "assistant_message",
                    status: "completed",
                    startedAt: timestamp,
                    completedAt: timestamp,
                    messageId: MessageId.make(`commentary-${index}`),
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
        expect(
          notices.filter((notice) => notice.text.includes('"status":"progress"')),
        ).toHaveLength(1);
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
        ).toHaveLength(1);
        completed = true;
        yield* agent.poll;
        yield* agent.poll;
        const finals = notices.filter((notice) => notice.text.includes("actualAgentResult"));
        expect(finals).toHaveLength(2);
        for (let index = 0; index < 2; index++) {
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

it.live.each(["Read the file.", "Read the blue file only. Do not edit."])(
  "late final %s cannot reauthorize a partial delegation",
  (finalText) =>
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
          instructions: "Read the file.",
        } as const;
        yield* agent.receive(delegation);
        yield* agent.receive({ type: "turn_done", role: "user", turnId: "final", text: finalText });
        yield* agent.receive({ ...delegation, delegationId: "late" });
        const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
        expect(records.runs).toHaveLength(1);
        expect(records.messages.find((message) => message.voice)?.text).toBe(finalText);
        expect(records.messages.find((message) => message.runId)?.text).toContain(finalText);
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
          yield* delegate("two", "two", "new-handoff");
        }
        const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
        expect(records.runs).toHaveLength(
          scenario === "unassociated" ? 0 : scenario === "handoff-replay" ? 2 : 1,
        );
        if (scenario === "reordered" || scenario === "interleaved") {
          const parent = scenario === "reordered" ? "one" : "two";
          const task = records.messages.find((message) => message.runId)!;
          expect(task.text).toContain(`"userTurnId":"${parent}"`);
          expect(task.text).toContain(`Generated instruction for ${parent}.`);
          expect(task.text).toContain("Corrected final. Keep blue only; do not edit.");
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
