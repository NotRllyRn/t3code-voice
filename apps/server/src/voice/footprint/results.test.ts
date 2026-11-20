import { expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2RunJson,
  OrchestrationV2TurnItemJson,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  TurnItemId,
  type LiveVoiceServerEvent,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../../orchestration-v2/ProviderEventIngestor.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { makeLiveAgentSession } from "../liveAgentSession.ts";
import { encodeNativeLiveAppend, type NativeLiveAppendMessage } from "../liveProtocol.ts";
import resultCapture from "../fixtures/live-native/result-association.json" with { type: "json" };
import { create, makeLayer } from "./testkit.ts";

const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    run: OrchestrationV2RunJson,
    attempt: OrchestrationV2RunAttemptJson,
    providerTurn: OrchestrationV2ProviderTurnJson,
    typedFinal: OrchestrationV2TurnItemJson,
    finalMessage: OrchestrationV2ConversationMessageJson,
  }),
);
const layer = ProviderEventIngestor.layer.pipe(
  Layer.provideMerge(makeLayer()),
  Layer.provide(IdAllocator.layer),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.die("Result replay must not resolve a provider"),
    }),
  ),
  Layer.merge(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: () => Effect.die("Result replay must not launch work"),
    }),
  ),
  Layer.merge(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/fixture/projects",
    }),
  ),
);

it.effect(
  "persisted provider-event replay joins the active root final to one native result; explicit resume redelivers without work",
  () =>
    Effect.gen(function* () {
      const captured = decode(resultCapture);
      const { run, providerTurn, typedFinal, finalMessage } = captured;
      if (typedFinal.type !== "assistant_message")
        throw new Error("Expected an authored final fixture");
      const attempt = { ...captured.attempt, attemptOrdinal: 2 };
      const threadId = run.threadId;
      yield* create(threadId);
      const sink = yield* EventSink.EventSinkV2;
      const events = yield* EventStore.EventStoreV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const driver = ProviderDriverKind.make("codex");
      const replay = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
        Effect.forEach(
          providerEvents,
          (event) =>
            ingestor.ingestNormalized({
              providerSessionId: ProviderSessionId.make("synthetic-result-replay"),
              providerInstanceId: run.providerInstanceId,
              threadId,
              runId: run.id,
              event,
            }),
          { discard: true },
        );
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:result-run"),
            type: "run.created",
            threadId,
            occurredAt: run.requestedAt,
            payload: { ...run, status: "running", completedAt: null },
          },
          {
            id: EventId.make("event:result-attempt"),
            type: "run-attempt.created",
            threadId,
            occurredAt: run.requestedAt,
            payload: { ...attempt, status: "running", completedAt: null },
          },
          {
            id: EventId.make("event:result-old-attempt"),
            type: "run-attempt.created",
            threadId,
            occurredAt: run.requestedAt,
            payload: { ...attempt, id: RunAttemptId.make("attempt:stale"), attemptOrdinal: 1 },
          },
        ],
      });
      yield* replay([
        {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...providerTurn, status: "running", completedAt: null },
        },
      ]);
      const wire: Array<readonly NativeLiveAppendMessage[]> = [];
      const notices: LiveVoiceServerEvent[] = [];
      const connect = (sessionId: string, resume = false) =>
        makeLiveAgentSession({
          binding: { threadId, ...(resume ? { resumeRunIds: [run.id] } : {}) },
          sessionId,
          onBound: () => {},
          send: (event) =>
            Effect.sync(() => {
              notices.push(event);
            }),
          append: (event) =>
            Effect.sync(() => {
              wire.push(encodeNativeLiveAppend(event));
            }),
        });
      const results = () =>
        wire
          .filter((batch) => batch[0]?.channel === "speakable")
          .map((batch) => JSON.parse(batch.map((frame) => frame.content[0].text).join("")));
      const agent = yield* connect("result-original");
      yield* agent.seed;
      // These are adapter-shaped events through the real ingestor, event log and SQL projector.
      yield* replay([
        { type: "message.updated", driver, message: finalMessage },
        { type: "turn_item.updated", driver, turnItem: typedFinal },
      ]);
      yield* agent.poll;
      expect(results()).toEqual([]);
      const staleTurn = {
        ...providerTurn,
        id: ProviderTurnId.make("turn:stale"),
        runAttemptId: RunAttemptId.make("attempt:stale"),
        ordinal: 2,
      };
      const childTurn = {
        ...providerTurn,
        id: ProviderTurnId.make("turn:child"),
        nodeId: NodeId.make("node:child-root"),
        providerThreadId: ProviderThreadId.make("thread:child-provider"),
      };
      for (const [name, turn] of [
        ["stale", staleTurn],
        ["child", childTurn],
      ] as const) {
        const message = {
          ...finalMessage,
          id: MessageId.make(`message:${name}-poison`),
          nodeId: NodeId.make(`node:${name}-poison`),
          text: `${name.toUpperCase()}_POISON_FINAL`,
        };
        yield* replay([
          { type: "provider_turn.updated", driver, providerTurn: turn },
          { type: "message.updated", driver, message },
          {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...typedFinal,
              id: TurnItemId.make(`item:${name}-poison`),
              messageId: message.id,
              nodeId: message.nodeId,
              providerTurnId: turn.id,
              providerThreadId: turn.providerThreadId,
              ordinal: typedFinal.ordinal + 1 + (name === "child" ? 1 : 0),
              text: message.text,
            },
          },
        ]);
      }
      const persisted = yield* store.getThreadRecords(threadId, ["messages", "turnItems"]);
      expect(persisted.messages.map((message) => message.id)).toEqual([
        finalMessage.id,
        "message:stale-poison",
        "message:child-poison",
      ]);
      expect(
        persisted.turnItems
          .filter((item) => item.type === "assistant_message")
          .map((item) => item.phase),
      ).toEqual(["final_answer", "final_answer", "final_answer"]);
      yield* agent.poll;
      expect(results()).toEqual([]);
      // Reachable ordering: the authored final commits before the root terminal.
      // This does not invent a promise to wait for a final that arrives after a terminal.
      yield* replay([{ type: "provider_turn.updated", driver, providerTurn }]);
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:result-attempt-ended"),
            type: "run-attempt.updated",
            threadId,
            occurredAt: run.completedAt!,
            payload: attempt,
          },
          {
            id: EventId.make("event:result-run-ended"),
            type: "run.updated",
            threadId,
            occurredAt: run.completedAt!,
            payload: run,
          },
        ],
      });
      const beforePoll = yield* store.getThreadRecords(threadId, [
        "runs",
        "messages",
        "turnItems",
        "attempts",
        "providerTurns",
      ]);
      const sequence = yield* events.latestSequence({ threadId });
      yield* agent.poll;
      yield* agent.poll;
      const expected = {
        runId: run.id,
        status: "completed",
        actualAgentResult: finalMessage.text,
        sourceMessageIds: [finalMessage.id],
      };
      expect(results()).toHaveLength(1);
      expect(results()[0]).toMatchObject(expected);
      expect(
        notices.filter((event) => event.type === "live.agent" && event.status === "completed"),
      ).toHaveLength(1);
      const ordinaryReconnect = yield* connect("result-reconnect");
      yield* ordinaryReconnect.seed;
      yield* ordinaryReconnect.poll;
      expect(results()).toHaveLength(1);
      const resumed = yield* connect("result-explicit-resume", true);
      yield* resumed.seed;
      yield* resumed.poll;
      yield* resumed.poll;
      expect(results()).toHaveLength(2);
      expect(results()[1]).toMatchObject(expected);
      expect(yield* events.latestSequence({ threadId })).toBe(sequence);
      expect(
        yield* store.getThreadRecords(threadId, [
          "runs",
          "messages",
          "turnItems",
          "attempts",
          "providerTurns",
        ]),
      ).toEqual(beforePoll);
      const authoredEvents = yield* Stream.runCollect(
        events.read({ threadId, eventType: "message.updated" }),
      );
      expect(authoredEvents).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
