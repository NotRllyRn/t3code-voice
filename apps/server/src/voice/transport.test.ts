import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- exercises real Node HTTP upgrades and ws backpressure.
import * as NodeHttp from "node:http";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { it as test } from "@effect/vitest";
import {
  boundedVoiceSocket,
  claimVoiceUpgrade,
  makeVoiceUpstream,
  MAX_BUFFER_BYTES,
  MAX_BUFFER_FRAMES,
  VoiceWebSocket,
} from "./transport.ts";
import { MAX_FRAME_BYTES } from "./protocol.ts";

async function pair() {
  const http = NodeHttp.createServer();
  const wss = new NodeWS.WebSocketServer({
    noServer: true,
    WebSocket: VoiceWebSocket,
    perMessageDeflate: true,
  });
  const accepted = new Promise<VoiceWebSocket>((resolve) => {
    http.once("upgrade", (request, socket, head) => {
      const claim = claimVoiceUpgrade(socket);
      wss.handleUpgrade(request, socket, head, () => resolve(claim.wire()!));
    });
  });
  http.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(http, "listening");
  const address = http.address();
  NodeAssert.ok(address && typeof address !== "string");
  const client = makeVoiceUpstream(`ws://127.0.0.1:${address.port}`, "test-only-not-a-live-key");
  await NodeEvents.EventEmitter.once(client, "open");
  const server = await accepted;
  return {
    client,
    server,
    async close() {
      client.terminate();
      server.terminate();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      wss.close();
    },
  };
}
const peers = Effect.acquireRelease(Effect.promise(pair), (value) =>
  Effect.promise(() => value.close()),
);
const directions = ["upstream", "downstream"] as const;

test.live.each(directions)(
  "bounds real ws egress to a nonreading %s and terminates on saturation",
  (direction) =>
    Effect.gen(function* () {
      const connection = yield* peers;
      const sender = direction === "upstream" ? connection.client : connection.server;
      const receiver = direction === "upstream" ? connection.server : connection.client;
      receiver.pause();
      const closed = NodeEvents.EventEmitter.once(sender, "close");
      const socket = boundedVoiceSocket(
        Socket.make({
          reader: Effect.die("No reader needed"),
          writer: Effect.die("Must not use the unbounded platform writer"),
        }),
        () => sender,
      );
      let accepted = 0;
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const writer = yield* socket.writer;
          const frame = "a".repeat(MAX_FRAME_BYTES - 1);
          for (let i = 0; i < 1024; i++) {
            yield* writer.write(frame);
            accepted++;
            NodeAssert.ok(sender.bufferedAmount <= MAX_BUFFER_BYTES);
          }
        }).pipe(Effect.result),
      );
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.ok(accepted < 1024);
      NodeAssert.ok(sender.bufferedAmount <= MAX_BUFFER_BYTES);
      yield* Effect.promise(() => closed);
      NodeAssert.equal(sender.readyState, NodeWS.WebSocket.CLOSED);
      NodeAssert.equal(String(result).includes("test-only-not-a-live-key"), false);
    }),
);

test.live.each(
  directions.flatMap((direction) => [
    { direction, kind: "frame-count", bytes: 1, count: MAX_BUFFER_FRAMES + 10 },
    { direction, kind: "byte-count", bytes: MAX_FRAME_BYTES - 1, count: 3 },
    { direction, kind: "max-payload", bytes: MAX_FRAME_BYTES + 1, count: 1 },
  ]),
)(
  "bounds $kind ingress from $direction before a consumer pulls",
  ({ direction, kind, bytes, count }) =>
    Effect.gen(function* () {
      const connection = yield* peers;
      const receiver = direction === "upstream" ? connection.client : connection.server;
      const sender = direction === "upstream" ? connection.server : connection.client;
      const closed = new Promise<void>((resolve) => receiver.once("close", () => resolve()));
      let received = 0;
      receiver.on("message", () => {
        received++;
      });
      const arrived = new Promise<void>((resolve) => receiver.once("message", () => resolve()));
      const raw = yield* Socket.fromWebSocket(Effect.succeed(receiver), {
        highWaterMark: 64 * 1024,
      });
      const socket = boundedVoiceSocket(raw, () => receiver);
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* socket.reader;
          for (let i = 0; i < count; i++) sender.send("x".repeat(bytes), { compress: false });
          if (kind === "byte-count") {
            yield* Effect.promise(() => arrived);
            NodeAssert.equal(receiver.isPaused, true);
            NodeAssert.ok(received * bytes <= MAX_BUFFER_BYTES);
            return;
          }
          yield* Effect.promise(() => closed);
          return yield* reader.pull;
        }).pipe(Effect.result),
      );
      if (kind === "byte-count") NodeAssert.equal(result._tag, "Success");
      else {
        NodeAssert.equal(result._tag, "Failure");
        NodeAssert.equal(receiver.readyState, NodeWS.WebSocket.CLOSED);
      }
    }),
);
