import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import { LiveConnectionError } from "@t3tools/provider-core/server/liveConnection";
import {
  acquireLiveCall,
  LiveNetwork,
  liveFailure,
  liveRetryAt,
  type LiveHttpResponse,
} from "./liveTransport.ts";
import { connection, peer, sdp } from "./liveTestkit.ts";

it("allows only structured definitive refresh failures, not quota/auth/arbitrary/ambiguous errors", () => {
  for (const [status, body, retry] of [
    [503, { error: { code: "refresh_failed" } }, true],
    [503, { error: { code: "auth_unavailable", refresh_pending: true } }, true],
    [503, { error: { code: "auth_unavailable" } }, false],
    [503, { error: { code: "refresh_failed" }, session: {} }, false],
    [503, { error: { code: "refresh_failed", call_id: "ambiguous" } }, false],
    [503, { error: { code: "insufficient_quota", refresh_pending: true } }, false],
    ...[401, 403, 429, 500, 502].map((status) => [
      status,
      { error: { code: "refresh_failed" } },
      false,
    ]),
  ] as const)
    expect(liveFailure(Number(status), JSON.stringify(body)).refresh).toBe(retry);
  expect(liveFailure(401, "private-key").reason).toBe("auth-required");
  expect(liveFailure(403, "private-key").reason).toBe("forbidden");
  expect(liveFailure(503, JSON.stringify({ error: { code: "insufficient_quota" } })).reason).toBe(
    "quota",
  );
  expect(liveRetryAt(0, 180000, null)).toBe(90000);
  expect(liveRetryAt(0, 180000, "91")).toBe(91000);
  expect(liveRetryAt(0, 180000, "999999999")).toBeUndefined();
  expect(liveRetryAt(46000, 180000, null)).toBeUndefined();
});

it.effect.each(["valid", "body", "sideband", "type", "identity", "no-location"] as const)(
  "owned allocation finalizer is registered before %s failure and never follows Location host",
  (failure) =>
    Effect.gen(function* () {
      const up = yield* peer;
      const hangups: string[] = [];
      let sidebands = 0;
      const result = yield* Effect.scoped(acquireLiveCall(connection, sdp)).pipe(
        Effect.provideService(LiveNetwork, {
          create: (selected, body) =>
            Effect.sync(() => {
              expect(Redacted.value(selected.headers).Authorization).toBe(
                "Bearer fictional-selected-key",
              );
              expect(body).not.toContain("fictional-selected-key");
              expect(JSON.parse(body).session.delegation).toEqual({ type: "client" });
              return {
                status: 201,
                contentType: failure === "type" ? "application/json" : "application/sdp",
                retryAfter: null,
                location:
                  failure === "no-location"
                    ? null
                    : failure === "identity"
                      ? "https://evil.example/live/poison?call_id=conflict"
                      : "https://evil.example/live/owned-call",
                body:
                  failure === "body"
                    ? Effect.fail(new LiveConnectionError({ reason: "timeout" }))
                    : Effect.succeed(sdp),
              };
            }),
          hangup: (_, url) =>
            Effect.sync(() => {
              hangups.push(url);
            }),
          sideband: (_, url) =>
            Effect.gen(function* () {
              sidebands++;
              expect(url).toBe("wss://relay.example.test/prefix/v1/live/owned-call");
              if (failure === "sideband")
                return yield* new LiveConnectionError({ reason: "temporarily-unavailable" });
              return up.socket;
            }),
        }),
        Effect.result,
      );
      expect(hangups).toEqual(
        ["no-location", "identity"].includes(failure)
          ? []
          : ["https://relay.example.test/prefix/v1/realtime/calls/owned-call/hangup"],
      );
      expect(result._tag).toBe(failure === "valid" ? "Success" : "Failure");
      if (["body", "type", "identity", "no-location"].includes(failure)) expect(sidebands).toBe(0);
    }),
);

it.effect("Stop/interrupt during POST still reaps a late known allocation exactly once", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const response = yield* Deferred.make<LiveHttpResponse>();
    let hangups = 0;
    let sidebands = 0;
    const fiber = yield* Effect.scoped(acquireLiveCall(connection, sdp)).pipe(
      Effect.provideService(LiveNetwork, {
        create: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(response))),
        hangup: () =>
          Effect.sync(() => {
            hangups++;
          }),
        sideband: () =>
          Effect.sync(() => {
            sidebands++;
          }).pipe(Effect.andThen(Effect.die("No sideband after Stop"))),
      }),
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(response, {
      status: 201,
      location: "/v1/live/late-owned",
      contentType: "application/sdp",
      retryAfter: null,
      body: Effect.succeed(sdp),
    });
    yield* Fiber.await(fiber);
    expect(hangups).toBe(1);
    expect(sidebands).toBe(0);
  }),
);

it.effect("Location or non-JSON failures and ambiguous POST losses cannot authorize retry", () =>
  Effect.gen(function* () {
    for (const location of [null, "/v1/live/allocated"])
      for (const contentType of ["text/plain", "application/json"]) {
        let hangups = 0;
        const outcome = yield* Effect.scoped(acquireLiveCall(connection, sdp)).pipe(
          Effect.provideService(LiveNetwork, {
            create: () =>
              Effect.succeed({
                status: 503,
                location,
                contentType,
                retryAfter: null,
                body: Effect.succeed('{"error":{"code":"refresh_failed"}}'),
              }),
            hangup: () =>
              Effect.sync(() => {
                hangups++;
              }),
            sideband: () => Effect.die("No sideband on 503"),
          }),
        );
        expect(outcome.type).toBe("rejected");
        if (outcome.type === "rejected")
          expect(outcome.refresh).toBe(location === null && contentType === "application/json");
        expect(hangups).toBe(location ? 1 : 0);
      }
  }),
);
