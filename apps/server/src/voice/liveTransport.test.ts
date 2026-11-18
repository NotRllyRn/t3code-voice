import * as NodeWS from "@effect/platform-node/NodeWS";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fictional loopback HTTP/WS boundary, no provider calls.
import * as NodeHttp from "node:http";
import { expect, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { FetchHttpClient } from "effect/http";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import * as Redacted from "effect/Redacted";
import type { LiveVoiceCleanupResult } from "@t3tools/contracts";
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

it.effect.each(["acknowledged", "timeout", "failure", "defect"] as const)(
  "hangup precedes lazy sideband release, including %s cleanup",
  (mode) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      const events: string[] = [];
      const logs: unknown[] = [];
      const cleanup: { result: LiveVoiceCleanupResult } = { result: "unknown" };
      const call = yield* acquireLiveCall(connection, sdp, cleanup).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(LiveNetwork, {
          create: () =>
            Effect.succeed({
              status: 201,
              location: "/v1/live/owned",
              contentType: "application/sdp",
              retryAfter: null,
              body: Effect.succeed(sdp),
            }),
          sideband: () =>
            Effect.succeed(
              Socket.make({
                reader: Effect.acquireRelease(
                  Effect.succeed({ pull: Effect.never, upgrade: () => Effect.void }),
                  () =>
                    Effect.sync(() => {
                      events.push("release");
                    }),
                ),
                writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
              }),
            ),
          hangup: () =>
            Effect.gen(function* () {
              events.push("hangup");
              yield* Deferred.succeed(entered, undefined);
              if (mode === "timeout") return yield* Effect.never;
              if (mode === "defect")
                return yield* Effect.die(new Error("fictional-private-cleanup"));
              if (mode === "failure")
                return yield* new LiveConnectionError({ reason: "temporarily-unavailable" });
            }),
        }),
        Effect.provide(
          Logger.layer([Logger.make(({ message, cause }) => logs.push({ message, cause }))], {
            mergeWithExisting: false,
          }),
        ),
      );
      if (call.type !== "created") throw new Error("Expected call");
      yield* call.socket.reader.pipe(Effect.provideService(Scope.Scope, scope));
      const close = yield* Scope.close(scope, Exit.void).pipe(
        Effect.ensuring(Deferred.succeed(closing, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      if (mode === "timeout") {
        expect(events).toEqual(["hangup"]);
        yield* TestClock.adjust("5 seconds");
      }
      yield* Deferred.await(closing);
      yield* Fiber.join(close);
      yield* Scope.close(scope, Exit.void);
      expect(events).toEqual(["hangup", "release"]);
      expect(cleanup.result).toBe(
        mode === "acknowledged" ? "acknowledged" : mode === "timeout" ? "unknown" : "failed",
      );
      expect(JSON.stringify(logs).includes("Live cleanup failed")).toBe(mode !== "acknowledged");
      expect(JSON.stringify(logs)).not.toContain("fictional-private-cleanup");
    }),
);

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
  for (const code of ["insufficient_quota", "quota_exceeded", "billing_hard_limit_reached"])
    expect(
      liveFailure(429, JSON.stringify({ error: { code, message: "fictional-private" } })),
    ).toEqual({ reason: "quota", refresh: false });
  expect(liveFailure(429, '{"error":{"code":"too_many_requests"}}')).toEqual({
    reason: "rate-limited",
    refresh: false,
  });
  expect(liveFailure(503, '{"error":{"code":"auth_unavailable"}}')).toEqual({
    reason: "auth-required",
    refresh: false,
  });
  expect(liveFailure(503, '{"error":{"code":"overloaded"}}')).toEqual({
    reason: "temporarily-unavailable",
    refresh: false,
  });
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

// CPA v8.0.63 sideband.go complete deletes the call map before closing resources;
// capabilities.go hangup peeks that same map, including while sideband is claimed.
it.live.each([
  "claimed",
  "interrupted",
  "closed",
  "upstream-404",
  "unauthorized",
  "stalled",
] as const)(
  "known-call cleanup uses its configured origin and preserves CPA %s semantics",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const closed = Promise.withResolvers<void>();
        const aborted = Promise.withResolvers<void>();
        const paths: string[] = [];
        const statuses: number[] = [];
        const logs: unknown[] = [];
        const ready = yield* Deferred.make<void>();
        let mapped = false;
        let sideband: NodeWS.WebSocket | undefined;
        const up = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const http = NodeHttp.createServer((request, response) => {
              paths.push(request.url!);
              expect(request.headers.authorization).toBe("Bearer fictional-selected-key");
              if (request.url === "/prefix/v1/live") {
                mapped = true;
                response.writeHead(201, {
                  "Content-Type": "application/sdp",
                  Location: "https://never-follow.example.test/live/owned-call",
                });
                response.end(sdp);
              } else if (request.url === "/prefix/v1/realtime/calls/owned-call/hangup") {
                if (mode === "stalled") {
                  response.once("close", () => aborted.resolve());
                  return;
                }
                const status = !mapped
                  ? 404
                  : mode === "unauthorized"
                    ? 403
                    : mode === "upstream-404"
                      ? 404
                      : 200;
                statuses.push(status);
                if (status === 200) {
                  mapped = false;
                  sideband?.terminate();
                }
                response.writeHead(status);
                response.end("fictional-private-response");
              } else {
                response.writeHead(404);
                response.end();
              }
            });
            const ws = new NodeWS.WebSocketServer({ server: http });
            ws.on("connection", (socket, request) => {
              paths.push(request.url!);
              expect(request.headers.authorization).toBe("Bearer fictional-selected-key");
              sideband = socket;
              socket.once("close", () => {
                mapped = false;
                closed.resolve();
              });
              socket.send("ready");
            });
            await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
            const address = http.address();
            if (!address || typeof address === "string") throw new Error("Expected loopback port");
            return { http, ws, origin: `http://127.0.0.1:${address.port}` };
          }),
          ({ http, ws }) =>
            Effect.promise(async () => {
              for (const socket of ws.clients) socket.terminate();
              await new Promise<void>((resolve) => http.close(() => resolve()));
              ws.close();
            }),
        );
        let locallyTerminated = false;
        const terminate = NodeWS.WebSocket.prototype.terminate;
        using _terminate = vi
          .spyOn(NodeWS.WebSocket.prototype, "terminate")
          .mockImplementation(function (this: NodeWS.WebSocket) {
            if (this.url === `${up.origin.replace("http:", "ws:")}/prefix/v1/live/owned-call`)
              locallyTerminated = true;
            terminate.call(this);
          });
        const context = yield* Layer.build(
          liveNetworkLayer.pipe(Layer.provide(FetchHttpClient.layer)),
        );
        const network = Context.get(context, LiveNetwork);
        const running = Effect.scoped(
          Effect.gen(function* () {
            const call = yield* acquireLiveCall(
              { ...connection, createUrl: `${up.origin}/prefix/v1/live` },
              sdp,
            );
            if (call.type !== "created") throw new Error("Expected call");
            const reader = yield* call.socket.reader;
            expect(yield* reader.pull).toEqual(["ready"]);
            if (mode === "interrupted") {
              yield* Deferred.succeed(ready, undefined);
              return yield* Effect.never;
            }
            if (mode === "closed") {
              sideband!.terminate();
              yield* Effect.promise(() => closed.promise);
              expect((yield* reader.pull.pipe(Effect.result))._tag).toBe("Failure");
            }
          }),
        ).pipe(
          Effect.provideService(LiveNetwork, {
            ...network,
            hangup: (selected, url) =>
              Effect.gen(function* () {
                // Exercise the schedule where CPA observes an earlier local terminate before HTTP arrives.
                if (locallyTerminated) yield* Effect.promise(() => closed.promise);
                yield* network.hangup(selected, url);
              }),
          }),
          Effect.provide(
            Logger.layer([Logger.make(({ message }) => logs.push(message))], {
              mergeWithExisting: false,
            }),
          ),
        );
        if (mode === "interrupted") {
          const fiber = yield* running.pipe(Effect.forkScoped);
          yield* Deferred.await(ready);
          yield* Fiber.interrupt(fiber);
        } else yield* running;
        yield* Effect.promise(() => closed.promise);
        if (mode === "stalled") yield* Effect.promise(() => aborted.promise);
        expect(paths).toEqual([
          "/prefix/v1/live",
          "/prefix/v1/live/owned-call",
          "/prefix/v1/realtime/calls/owned-call/hangup",
        ]);
        expect(statuses).toEqual(
          mode === "stalled"
            ? []
            : [
                mode === "claimed" || mode === "interrupted"
                  ? 200
                  : mode === "unauthorized"
                    ? 403
                    : 404,
              ],
        );
        expect(JSON.stringify(logs).includes("Live cleanup failed")).toBe(
          mode !== "claimed" && mode !== "interrupted",
        );
        expect(JSON.stringify(logs)).not.toMatch(/fictional|owned-call|127\.0\.0\.1/);
        expect(mapped).toBe(false);
        expect(logs).toContainEqual([
          "Live sideband closed",
          {
            failureStage: mode === "closed" ? "sideband-peer-close" : "sideband-release",
            initiator: mode === "closed" ? "upstream" : "local",
            webSocketCloseCode: 1006,
          },
        ]);
      }),
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

it.live.each(["peer-close", "peer-error", "protocol-error", "local-stop"] as const)(
  "sideband lifecycle logs retain %s without private close reasons",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* loopbackServer;
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected loopback port");
        const connected = Promise.withResolvers<NodeWS.WebSocket>();
        server.once("connection", (ws) => {
          connected.resolve(ws);
          ws.send("ready");
        });
        const logs: unknown[] = [];
        const context = yield* Layer.build(
          liveNetworkLayer.pipe(Layer.provide(FetchHttpClient.layer)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* Context.get(context, LiveNetwork).sideband(
              connection,
              `ws://127.0.0.1:${address.port}/private-token`,
            );
            const reader = yield* socket.reader;
            expect(yield* reader.pull).toEqual(["ready"]);
            const remote = yield* Effect.promise(() => connected.promise);
            if (mode === "peer-close") remote.close(4001, "fictional-secret-close-reason");
            if (mode === "peer-error") remote.terminate();
            if (mode === "protocol-error") remote.send(Buffer.from([0xff]), { binary: false });
            if (mode !== "local-stop")
              expect((yield* reader.pull.pipe(Effect.result))._tag).toBe("Failure");
          }),
        ).pipe(
          Effect.provide(
            Logger.layer([Logger.make(({ message, cause }) => logs.push({ message, cause }))], {
              mergeWithExisting: false,
            }),
          ),
        );
        expect(logs).toContainEqual({
          message: [
            "Live sideband closed",
            {
              failureStage:
                mode === "local-stop"
                  ? "sideband-release"
                  : mode === "protocol-error"
                    ? "sideband-error"
                    : "sideband-peer-close",
              initiator:
                mode === "local-stop"
                  ? "local"
                  : mode === "protocol-error"
                    ? "unknown"
                    : "upstream",
              webSocketCloseCode: mode === "peer-close" ? 4001 : 1006,
            },
          ],
          cause: expect.anything(),
        });
        expect(JSON.stringify(logs)).not.toMatch(/fictional|private-token|127\.0\.0\.1|Bearer|v=0/);
        expect(logs).toHaveLength(1);
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
      const terminate = NodeWS.WebSocket.prototype.terminate;
      let wire: NodeWS.WebSocket | undefined;
      using _terminate = vi
        .spyOn(NodeWS.WebSocket.prototype, "terminate")
        .mockImplementation(function (this: NodeWS.WebSocket) {
          wire = this;
          expect(this.listenerCount("close")).toBeGreaterThan(0);
          terminate.call(this);
        });
      yield* Effect.scoped(
        Effect.gen(function* () {
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
      );
      expect(_terminate).toHaveBeenCalledTimes(1);
      expect(wire?.readyState).toBe(NodeWS.WebSocket.CLOSED);
      expect(wire?.listenerCount("close")).toBe(0);
    }),
  ),
);
