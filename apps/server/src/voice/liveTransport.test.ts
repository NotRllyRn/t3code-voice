import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import { LiveConnectionError } from "@t3tools/provider-core/server/liveConnection";
import {
  acquireLiveCall,
  LiveNetwork,
  liveFailure,
  liveNetworkLayer,
  liveRetryAt,
  type LiveHttpResponse,
} from "./liveTransport.ts";
import { connection, peer, sdp } from "./liveTestkit.ts";
import { MAX_BUFFER_BYTES, MAX_BUFFER_FRAMES } from "./transport.ts";

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

it.each([
  [0, null, 90000],
  [0, "91", 91000],
  [0, "0", 90000],
  [0, "000000000000000000000000000000000000000000000000000000", 90000],
  [0, "0000000000100", 100000],
  [0, "135", 135000],
  [0, "136", undefined],
  [0, "999999999", undefined],
  [0, "1000000000", undefined],
  [0, "9007199254740992", undefined],
  [0, "9".repeat(400), undefined],
  [0, "Thu, 01 Jan 1970 00:01:40 GMT", 100000],
  [0, "Thu, 01 Jan 1970 00:03:00 GMT", undefined],
  [0, "Wed, 31 Dec 1969 23:59:59 GMT", 90000],
  [0, "invalid", 90000],
  [46000, null, undefined],
  [46000, "Thu, 01 Jan 1970 00:01:40 GMT", undefined],
] as const)("respects Retry-After and the remaining startup budget (%s, %s)", (now, header, at) => {
  expect(liveRetryAt(now, 180000, header)).toBe(at);
});

const loopbackServer = Effect.acquireRelease(
  Effect.sync(() => new NodeWS.WebSocketServer({ port: 0, host: "127.0.0.1" })),
  (server) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
).pipe(
  Effect.tap((server) =>
    Effect.promise(() => new Promise<void>((resolve) => server.once("listening", resolve))),
  ),
);

it.live.each(["bytes", "frames", "callback-error"] as const)(
  "native sideband bounds %s without waiting for writes and reaps its allocation",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* loopbackServer;
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected loopback port");
        let wire: NodeWS.WebSocket | undefined;
        let buffered = 0;
        let peakBytes = 0;
        const callbacks: Array<(error?: Error) => void> = [];
        using _buffered = vi
          .spyOn(NodeWS.WebSocket.prototype, "bufferedAmount", "get")
          .mockImplementation(() => buffered);
        using _send = vi.spyOn(NodeWS.WebSocket.prototype, "send").mockImplementation(function (
          this: NodeWS.WebSocket,
          ...args: Parameters<NodeWS.WebSocket["send"]>
        ) {
          wire = this;
          const [data, , callback] = args;
          if (callback) callbacks.push(callback);
          if (mode === "bytes") {
            buffered += Buffer.byteLength(String(data)) + 14;
            peakBytes = Math.max(peakBytes, 2 * buffered);
          }
        });
        const context = yield* Layer.build(
          liveNetworkLayer.pipe(Layer.provide(FetchHttpClient.layer)),
        );
        const network = Context.get(context, LiveNetwork);
        let creates = 0;
        let hangups = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const call = yield* acquireLiveCall(connection, sdp);
            if (call.type !== "created") throw new Error("Expected allocation");
            const reader = yield* call.socket.reader;
            const writer = yield* call.socket.writer;
            if (mode === "callback-error") {
              yield* writer.write("queued");
              expect(callbacks[0]).toBeTypeOf("function");
              callbacks[0]?.(new Error("fictional write failure"));
              expect((yield* writer.write("must fail").pipe(Effect.result))._tag).toBe("Failure");
            } else {
              const frame = mode === "bytes" ? "x".repeat(8192) : "";
              const result = yield* writer
                .writeAll(Array.from({ length: 1024 }, () => frame) as [string, ...string[]])
                .pipe(Effect.result);
              expect(result._tag).toBe("Failure");
            }
            expect(callbacks.length).toBeGreaterThan(0);
            expect(callbacks.length).toBeLessThanOrEqual(MAX_BUFFER_FRAMES);
            expect(peakBytes).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
            const writes = callbacks.length;
            expect((yield* writer.write("after failure").pipe(Effect.result))._tag).toBe("Failure");
            expect(callbacks).toHaveLength(writes);
            expect((yield* reader.pull.pipe(Effect.result))._tag).toBe("Failure");
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  if (!wire || wire.readyState === NodeWS.WebSocket.CLOSED) resolve();
                  else wire.once("close", () => resolve());
                }),
            );
            expect(wire?.readyState).toBe(NodeWS.WebSocket.CLOSED);
          }),
        ).pipe(
          Effect.provideService(LiveNetwork, {
            ...network,
            create: () =>
              Effect.sync(() => {
                creates++;
                return {
                  status: 201,
                  contentType: "application/sdp",
                  location: "/v1/live/owned",
                  retryAfter: null,
                  body: Effect.succeed(sdp),
                };
              }),
            sideband: (selected) =>
              network.sideband(selected, `ws://127.0.0.1:${address.port}/v1/live/owned`),
            hangup: () =>
              Effect.sync(() => {
                hangups++;
              }),
          }),
        );
        expect(creates).toBe(1);
        expect(hangups).toBe(1);
        // Completion may arrive after termination; it must not revive the writer or retain a queue.
        buffered = 0;
        for (const callback of callbacks) callback();
      }),
    ),
);

it.live("native sideband releases send reservations for an ordinary reading peer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* loopbackServer;
      server.on("connection", (ws) => ws.on("message", (data) => ws.send(data.toString())));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected loopback port");
      const context = yield* Layer.build(
        liveNetworkLayer.pipe(Layer.provide(FetchHttpClient.layer)),
      );
      const socket = yield* Context.get(context, LiveNetwork).sideband(
        connection,
        `ws://127.0.0.1:${address.port}/v1/live/reading`,
      );
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      for (let index = 0; index <= MAX_BUFFER_FRAMES; index++) {
        yield* writer.write(`fixture-${index}`);
        expect(yield* reader.pull).toEqual([`fixture-${index}`]);
      }
    }),
  ),
);
