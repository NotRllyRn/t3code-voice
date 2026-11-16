import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { LiveConnectionError } from "@t3tools/provider-core/server/liveConnection";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { runLiveSession } from "./liveSession.ts";
import { LiveNetwork } from "./liveTransport.ts";
import { connection, peer, sdp } from "./liveTestkit.ts";

const agents = Layer.mergeAll(
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/fixture/projects",
  }),
);
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
      const down = yield* peer;
      const up = yield* peer;
      const creates: string[] = [];
      let hangups = 0;
      const fiber = yield* runLiveSession({
        socket: down.socket,
        binding,
        connection,
        capability,
        validateOwner: Effect.void,
        onBound: () => {},
      }).pipe(
        Effect.provide(agents),
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
      expect(up.closed()).toBe(true);
      expect(down.closed()).toBe(true);
    }),
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
