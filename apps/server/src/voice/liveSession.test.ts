import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  NodeId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Logger from "effect/Logger";
import * as Socket from "effect/socket/Socket";
import { LiveConnectionError } from "@t3tools/provider-core/server/liveConnection";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as VoiceFixture from "../orchestration-v2/VoiceConversation.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { makeLiveAgentSession } from "./liveAgentSession.ts";
import { runLiveSession } from "./liveSession.ts";
import { LiveNetwork } from "./liveTransport.ts";
import { connection, peer, sdp } from "./liveTestkit.ts";

const agentAux = Layer.mergeAll(
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/fixture/projects",
  }),
);
const agents = Layer.mergeAll(Layer.mock(ThreadManagement.ThreadManagementService)({}), agentAux);
const capability = {
  environmentId: EnvironmentId.make("fixture-environment"),
  providerInstanceId: ProviderInstanceId.make("selected-instance"),
  protocol: "cpa-codex-live",
  requestedModel: "gpt-live-1.1-codex",
  effectiveModel: null,
} as const;
const binding = {
  draft: {
    modelSelection: { instanceId: capability.providerInstanceId, model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
} as const;

it.effect(
  "server authorizes fresh attempts; 90s wait is cancellable, bounded and never an immediate retry",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fixture-retry-thread");
      yield* VoiceFixture.create(threadId);
      const down = yield* peer;
      const up = yield* peer;
      const creates: string[] = [];
      let hangups = 0;
      let releases = 0;
      const fiber = yield* runLiveSession({
        socket: down.socket,
        binding: { threadId },
        connection,
        capability,
        validateOwner: Effect.void,
        onBound: () => {},
        onStopped: () => {
          expect(hangups).toBe(1);
          expect(up.closed()).toBe(true);
          releases++;
        },
      }).pipe(
        Effect.provide(agentAux),
        Effect.provideService(LiveNetwork, {
          create: (_, body) =>
            Effect.sync(() => {
              creates.push(JSON.parse(body).sdp);
              return creates.length === 1
                ? {
                    status: 503,
                    location: null,
                    contentType: "application/json",
                    retryAfter: null,
                    body: Effect.succeed('{"error":{"code":"refresh_failed"}}'),
                  }
                : {
                    status: 201,
                    location: "/v1/live/owned",
                    contentType: "application/sdp",
                    retryAfter: null,
                    body: Effect.succeed(sdp),
                  };
            }),
          hangup: () =>
            Effect.sync(() => {
              hangups++;
            }),
          sideband: () => Effect.succeed(up.socket),
        }),
        Effect.scoped,
        Effect.forkScoped,
      );
      const initial = JSON.parse(yield* Queue.take(down.output));
      expect(initial.type).toBe("live.status");
      expect(initial.phase).toBe("connecting");
      expect(initial.attemptId).toBeTruthy();
      yield* Queue.offer(
        down.input,
        JSON.stringify({ type: "live.start", attemptId: initial.attemptId, offerSdp: sdp }),
      );
      yield* Queue.take(down.output); // connecting with same authorization
      const wait = JSON.parse(yield* Queue.take(down.output));
      expect(wait.phase).toBe("refresh_wait");
      expect(wait.retryAt).toBe(90000);
      expect(wait.deadlineAt).toBe(180000);
      for (let index = 0; index < 8; index++) {
        yield* Queue.offer(down.input, '{"type":"live.heartbeat"}');
        yield* TestClock.adjust("10 seconds");
      }
      expect(creates).toHaveLength(1);
      yield* Queue.offer(down.input, '{"type":"live.heartbeat"}');
      yield* TestClock.adjust("10 seconds");
      const retry = JSON.parse(yield* Queue.take(down.output));
      expect(retry.phase).toBe("connecting");
      expect(retry.attemptId).not.toBe(initial.attemptId);
      const fresh = sdp.replace("42 2", "43 3");
      yield* Queue.offer(
        down.input,
        JSON.stringify({ type: "live.start", attemptId: retry.attemptId, offerSdp: fresh }),
      );
      yield* Queue.take(down.output);
      const answer = JSON.parse(yield* Queue.take(down.output));
      expect(answer.type).toBe("live.answer");
      expect(creates).toEqual([sdp, fresh]);
      yield* Queue.offer(up.input, '{"type":"session.started","session":{"id":"native-owned"}}');
      yield* Queue.offer(
        down.input,
        JSON.stringify({ type: "live.peer", attemptId: retry.attemptId, state: "connected" }),
      );
      const connected = JSON.parse(yield* Queue.take(down.output));
      expect(connected.phase).toBe("connected");
      yield* Queue.offer(down.input, '{"type":"live.stop"}');
      yield* Fiber.join(fiber);
      expect(hangups).toBe(1);
      expect(releases).toBe(1);
      expect(JSON.parse(yield* Queue.take(down.output))).toMatchObject({
        type: "live.cleanup",
        result: "acknowledged",
      });
      expect(yield* Queue.size(down.output)).toBe(0);
      expect(up.closed()).toBe(true);
      expect(down.closed()).toBe(true);
    }).pipe(Effect.provide(VoiceFixture.layer)),
);

it.effect.each(["peer-close", "error", "approval-pending"] as const)(
  "lifecycle diagnostics survive cleanup: %s",
  (mode) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fixture-diagnostics-thread");
      yield* VoiceFixture.create(threadId);
      const threads = yield* ThreadManagement.ThreadManagementService;
      const down = yield* peer;
      const up = yield* peer;
      const logs: unknown[] = [];
      const nativeClose = yield* Deferred.make<never, Socket.SocketError>();
      let hangups = 0;
      let recordsRead = 0;
      const fiber = yield* runLiveSession({
        socket: down.socket,
        binding: { threadId },
        connection,
        capability,
        validateOwner: Effect.void,
        onBound: () => {},
      }).pipe(
        Effect.provide(agentAux),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ...threads,
          getThreadRecords: (...args) =>
            threads.getThreadRecords(...args).pipe(
              Effect.map((records) => {
                recordsRead++;
                return {
                  ...records,
                  runtimeRequests:
                    mode === "approval-pending"
                      ? [
                          {
                            id: RuntimeRequestId.make("fictional-approval"),
                            nodeId: NodeId.make("fictional-node"),
                            providerTurnId: null,
                            nativeRequestRef: null,
                            kind: "command" as const,
                            status: "pending" as const,
                            responseCapability: { type: "message" as const },
                            createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
                            resolvedAt: null,
                          },
                        ]
                      : [],
                };
              }),
            ),
        }),
        Effect.provideService(LiveNetwork, {
          create: () =>
            Effect.succeed({
              status: 201,
              location: "/v1/live/owned",
              contentType: "application/sdp",
              retryAfter: null,
              body: Effect.succeed(sdp),
            }),
          hangup: () =>
            Effect.sync(() => {
              hangups++;
            }),
          sideband: () =>
            Effect.succeed(
              Socket.make({
                reader: up.socket.reader.pipe(
                  Effect.map((reader) => ({
                    ...reader,
                    pull: reader.pull.pipe(Effect.raceFirst(Deferred.await(nativeClose))),
                  })),
                ),
                writer: up.socket.writer,
              }),
            ),
        }),
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logs.push(message))], {
            mergeWithExisting: false,
          }),
        ),
        Effect.scoped,
        Effect.forkScoped,
      );
      const initial = JSON.parse(yield* Queue.take(down.output));
      yield* Queue.offer(
        down.input,
        JSON.stringify({ type: "live.start", attemptId: initial.attemptId, offerSdp: sdp }),
      );
      yield* Queue.take(down.output);
      expect(JSON.parse(yield* Queue.take(down.output)).type).toBe("live.answer");
      yield* Queue.offer(
        up.input,
        '{"type":"session.started","session":{"id":"fictional-private-id"}}',
      );
      yield* Queue.offer(
        down.input,
        JSON.stringify({ type: "live.peer", attemptId: initial.attemptId, state: "connected" }),
      );
      expect(JSON.parse(yield* Queue.take(down.output)).phase).toBe("connected");
      if (mode === "approval-pending") {
        for (let tick = 0; tick < 20; tick++) {
          yield* Queue.offer(down.input, '{"type":"live.heartbeat"}');
          yield* TestClock.adjust("10 seconds");
        }
        expect(recordsRead).toBeGreaterThan(1);
        expect(hangups).toBe(0);
        expect(logs).toEqual([]);
        expect(yield* Queue.size(down.output)).toBe(0);
        yield* Queue.offer(down.input, '{"type":"live.stop"}');
      } else if (mode === "peer-close")
        yield* Deferred.fail(
          nativeClose,
          new Socket.SocketError({
            reason: new Socket.SocketCloseError({
              code: 4001,
              closeReason: "fictional-secret-close-reason",
            }),
          }),
        );
      else
        yield* Queue.offer(
          up.input,
          JSON.stringify({
            type: "error",
            reason: "fictional-secret-close-reason",
            code: 4567,
            message: "fictional-secret-message",
          }),
        );
      yield* Fiber.join(fiber);
      expect(hangups).toBe(1);
      expect(up.closed()).toBe(true);
      expect(logs).toEqual([
        [
          "Live session ended",
          {
            failureStage:
              mode === "approval-pending"
                ? "app-stop"
                : mode === "peer-close"
                  ? "native-read"
                  : "native-error",
            initiator:
              mode === "approval-pending"
                ? "local"
                : mode === "peer-close"
                  ? "unknown"
                  : "upstream",
          },
        ],
      ]);
      expect(JSON.stringify(logs)).not.toMatch(/fictional|4567|Bearer|v=0|https:/);
    }).pipe(Effect.provide(VoiceFixture.layer)),
);

it.effect.each(["stop", "unauthorized-offer", "stale-config", "budget", "heartbeat"] as const)(
  "%s cannot allocate or trigger a task",
  (failure) =>
    Effect.gen(function* () {
      const down = yield* peer;
      let creates = 0;
      const fiber = yield* runLiveSession({
        socket: down.socket,
        binding,
        connection,
        capability,
        validateOwner:
          failure === "stale-config"
            ? Effect.fail(new LiveConnectionError({ reason: "connection-changed" }))
            : Effect.void,
        onBound: () => {},
      }).pipe(
        Effect.provide(agents),
        Effect.provideService(LiveNetwork, {
          create: () =>
            Effect.sync(() => {
              creates++;
            }).pipe(Effect.andThen(Effect.die("No create"))),
          hangup: () => Effect.void,
          sideband: () => Effect.die("No sideband"),
        }),
        Effect.scoped,
        Effect.forkScoped,
      );
      const initial = JSON.parse(yield* Queue.take(down.output));
      if (failure === "budget") {
        for (let tick = 0; tick < 18; tick++) {
          yield* Queue.offer(down.input, '{"type":"live.heartbeat"}');
          yield* TestClock.adjust("10 seconds");
        }
      } else if (failure === "heartbeat") yield* TestClock.adjust("46 seconds");
      else
        yield* Queue.offer(
          down.input,
          failure === "stop"
            ? '{"type":"live.stop"}'
            : JSON.stringify({
                type: "live.start",
                attemptId: failure === "unauthorized-offer" ? "browser-chosen" : initial.attemptId,
                offerSdp: sdp,
              }),
        );
      yield* Fiber.join(fiber);
      expect(creates).toBe(0);
    }),
);

it.effect.each(["ready", "binding"] as const)(
  "draft Stop while %s preserves reachable history before microphone readiness",
  (phase) =>
    Effect.gen(function* () {
      const down = yield* peer;
      const up = yield* peer;
      const threadId = ThreadId.make("draft-stop-thread");
      const threads = yield* ThreadManagement.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const bindingEntered = yield* Deferred.make<void>();
      const bindingRelease = yield* Deferred.make<void>();
      let launches = 0;
      const fiber = yield* runLiveSession({
        socket: down.socket,
        binding: { draft: { ...binding.draft, projectId: VoiceFixture.projectId } },
        connection,
        capability,
        validateOwner: Effect.void,
        onBound: () => {},
      }).pipe(
        Effect.provide(
          Layer.merge(
            agentAux,
            Layer.mock(ThreadLaunch.ThreadLaunchService)({
              launch: () =>
                Effect.gen(function* () {
                  launches++;
                  yield* VoiceFixture.create(threadId).pipe(
                    Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
                  );
                  yield* Deferred.succeed(bindingEntered, undefined);
                  if (phase === "binding") yield* Deferred.await(bindingRelease);
                  return {
                    threadId,
                    projection: yield* threads.getThreadProjection(threadId),
                    resumed: false,
                  };
                }).pipe(Effect.orDie),
            }),
          ),
        ),
        Effect.provideService(LiveNetwork, {
          create: () =>
            Effect.succeed({
              status: 201,
              contentType: "text/plain",
              location: "/v1/live/draft-call",
              retryAfter: null,
              body: Effect.succeed(sdp),
            }),
          sideband: () => Effect.succeed(up.socket),
          hangup: () => Effect.void,
        }),
        Effect.scoped,
        Effect.forkScoped,
      );
      const first = JSON.parse(yield* Queue.take(down.output));
      yield* Queue.offer(
        down.input,
        JSON.stringify({ type: "live.start", attemptId: first.attemptId, offerSdp: sdp }),
      );
      yield* Queue.take(down.output);
      yield* Queue.take(down.output);
      yield* Queue.offer(up.input, '{"type":"session.started","session":{"id":"draft-native"}}');
      yield* Queue.offer(
        down.input,
        JSON.stringify({ type: "live.peer", attemptId: first.attemptId, state: "connected" }),
      );
      if (phase === "binding") {
        yield* Deferred.await(bindingEntered);
        yield* Queue.offer(
          up.input,
          '{"type":"input_transcript.added","item":{"text":"Not admitted while binding."}}',
        );
        yield* Queue.offer(down.input, '{"type":"live.stop"}');
        yield* Fiber.join(fiber);
        const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
        expect(records.messages).toHaveLength(0);
        expect(records.runs).toHaveLength(0);
        expect(JSON.parse(yield* Queue.take(down.output))).toMatchObject({
          type: "live.cleanup",
          result: "acknowledged",
        });
        expect(yield* Queue.size(down.output)).toBe(0);
        return;
      }
      const receipt = JSON.parse(yield* Queue.take(down.output));
      expect(receipt).toEqual({ type: "live.bound", threadId });
      expect(JSON.parse(yield* Queue.take(down.output)).phase).toBe("connected");
      yield* Queue.offer(
        up.input,
        '{"type":"input_transcript.added","item":{"text":"Remember the violet kite."}}',
      );
      expect(JSON.parse(yield* Queue.take(down.output)).committed).toBe(false);
      yield* Queue.offer(down.input, '{"type":"live.stop"}');
      yield* Fiber.join(fiber);
      expect(launches).toBe(1);
      const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
      expect(records.messages.map((message) => message.text)).toEqual([
        "Remember the violet kite.",
      ]);
      expect(records.runs).toHaveLength(0);
      const history: string[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const restarted = yield* makeLiveAgentSession({
            binding: { threadId: receipt.threadId },
            sessionId: "restarted",
            onBound: () => {},
            send: () => Effect.void,
            append: (event) =>
              Effect.sync(() => {
                history.push(event.text);
              }),
          }).pipe(Effect.provide(agentAux));
          yield* restarted.seed;
          expect(restarted.getThreadId()).toBe(threadId);
          expect(history[0]).toContain("Remember the violet kite.");
        }),
      );
      expect(launches).toBe(1);
    }).pipe(Effect.provide(VoiceFixture.layer)),
);
