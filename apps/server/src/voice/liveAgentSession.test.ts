import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  type LiveVoiceServerEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as VoiceFixture from "../orchestration-v2/VoiceConversation.testkit.ts";
import { sendRecordedVoiceMessage } from "../orchestration-v2/VoiceConversation.ts";
import { makeLiveAgentSession } from "./liveAgentSession.ts";
import type { NativeLiveAppend } from "./liveProtocol.ts";

const services = Layer.mergeAll(
  VoiceFixture.layer,
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/fixture/projects",
  }),
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
        type: "transcript",
        role: "user",
        itemId: "permission-words",
        text: "Yes approve that.",
      });
      yield* agent.receive({
        type: "delegation",
        delegationId: "permission-delegation",
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
