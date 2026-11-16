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

it.effect.each([
  "stop-wait",
  "second-503",
  "same-sdp",
  "changed-config",
  "401",
  "403",
  "quota",
  "ambiguous",
  "long-retry",
  "overflow-retry",
  "date-retry",
  "padded-retry",
] as const)("%s is terminal or stops safely without a third/unapproved allocation", (mode) =>
  Effect.gen(function* () {
    const down = yield* peer;
    let creates = 0;
    let validations = 0;
    const fiber = yield* runLiveSession({
      socket: down.socket,
      binding,
      connection,
      capability,
      onBound: () => {},
      validateOwner: Effect.suspend(() => {
        validations++;
        return mode === "changed-config" && validations > 1
          ? Effect.fail(new LiveConnectionError({ reason: "connection-changed" }))
          : Effect.void;
      }),
    }).pipe(
      Effect.provide(agents),
      Effect.provideService(LiveNetwork, {
        create: () =>
          Effect.suspend(() => {
            creates++;
            if (mode === "ambiguous")
              return Effect.fail(new LiveConnectionError({ reason: "temporarily-unavailable" }));
            return Effect.succeed({
              status: mode === "401" ? 401 : mode === "403" ? 403 : 503,
              location: null,
              contentType: "application/json",
              retryAfter:
                mode === "long-retry"
                  ? "1000000000"
                  : mode === "overflow-retry"
                    ? "9".repeat(400)
                    : mode === "date-retry"
                      ? "Thu, 01 Jan 1970 00:03:00 GMT"
                      : mode === "padded-retry"
                        ? "0000000000100"
                        : null,
              body: Effect.succeed(
                mode === "quota"
                  ? '{"error":{"code":"insufficient_quota","refresh_pending":true}}'
                  : '{"error":{"code":"refresh_failed"}}',
              ),
            });
          }),
        hangup: () => Effect.die("No allocation was returned"),
        sideband: () => Effect.die("No success"),
      }),
      Effect.scoped,
      Effect.forkScoped,
    );
    const initial = JSON.parse(yield* Queue.take(down.output));
    yield* Queue.offer(
      down.input,
      JSON.stringify({ type: "live.start", attemptId: initial.attemptId, offerSdp: sdp }),
    );
    yield* Queue.take(down.output);
    const failure = JSON.parse(yield* Queue.take(down.output));
    if (
      ["401", "403", "quota", "ambiguous", "long-retry", "overflow-retry", "date-retry"].includes(
        mode,
      )
    ) {
      expect(failure.type).toBe("live.status");
      expect(failure.phase).toBe("error");
    } else {
      expect(failure.phase).toBe("refresh_wait");
      if (mode === "stop-wait") yield* Queue.offer(down.input, '{"type":"live.stop"}');
      else {
        for (let tick = 0; tick < 9; tick++) {
          yield* Queue.offer(down.input, '{"type":"live.heartbeat"}');
          yield* TestClock.adjust("10 seconds");
        }
        if (mode === "padded-retry") {
          expect(failure.retryAt).toBe(100000);
          expect(yield* Queue.size(down.output)).toBe(0);
          expect(creates).toBe(1);
          yield* Queue.offer(down.input, '{"type":"live.heartbeat"}');
          yield* TestClock.adjust("10 seconds");
        }
        const retry = JSON.parse(yield* Queue.take(down.output));
        if (mode === "changed-config") expect(retry.phase).toBe("error");
        else {
          expect(retry.phase).toBe("connecting");
          yield* Queue.offer(
            down.input,
            JSON.stringify({
              type: "live.start",
              attemptId: retry.attemptId,
              offerSdp: mode === "same-sdp" ? sdp : sdp.replace("42 2", "43 3"),
            }),
          );
          if (mode === "second-503" || mode === "padded-retry") yield* Queue.take(down.output);
          const terminal = JSON.parse(yield* Queue.take(down.output));
          expect(terminal.phase).toBe("error");
        }
      }
    }
    yield* Fiber.join(fiber);
    expect(creates).toBe(mode === "second-503" || mode === "padded-retry" ? 2 : 1);
    yield* TestClock.adjust("180 seconds");
    expect(creates).toBe(mode === "second-503" || mode === "padded-retry" ? 2 : 1);
    expect(down.closed()).toBe(true);
  }),
);
