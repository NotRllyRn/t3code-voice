import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import { relayVoiceSockets } from "./relay.ts";
import { sessionUpdate } from "./protocol.ts";

// Exercise Effect's real lazy WebSocket adapter, not just queue-backed sockets.
class Wire extends EventTarget {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  send(frame: string) {
    this.sent.push(frame);
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "session.updated" }) }),
      ),
    );
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

const peer = Effect.gen(function* () {
  const input = yield* Queue.unbounded<string>();
  const output = yield* Queue.unbounded<string>();
  let closed = false;
  const socket = Socket.make({
    reader: Effect.acquireRelease(
      Effect.succeed({
        pull: Queue.take(input).pipe(Effect.map((frame) => [frame] as const)),
        upgrade: () => Effect.void,
      }),
      () =>
        Effect.sync(() => {
          closed = true;
        }),
    ),
    writer: Effect.succeed({
      write: (frame) => Queue.offer(output, String(frame)).pipe(Effect.asVoid),
      writeAll: (frames) =>
        Effect.forEach(frames, (frame) => Queue.offer(output, String(frame)), { discard: true }),
    }),
  });
  return { socket, input, output, closed: () => closed };
});

test("relay configures server-owned session, gates ready, relays audio, rejects tools, and releases readers", async () => {
  let peers: Array<{ closed: () => boolean }> = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const down = yield* peer,
          up = yield* peer;
        peers = [down, up];
        const fiber = yield* relayVoiceSockets(
          down.socket,
          up.socket,
          sessionUpdate("alloy", ""),
          Effect.never,
        ).pipe(Effect.forkScoped);
        const setup = JSON.parse(yield* Queue.take(up.output));
        assert.equal(setup.type, "session.update");
        assert.deepEqual(setup.session.tools, []);
        yield* Queue.offer(
          up.input,
          JSON.stringify({ type: "session.updated", secret: "never-forward" }),
        );
        assert.deepEqual(JSON.parse(yield* Queue.take(down.output)), { type: "relay.ready" });
        yield* Queue.offer(
          down.input,
          JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAAAA==" }),
        );
        assert.deepEqual(JSON.parse(yield* Queue.take(up.output)), {
          type: "input_audio_buffer.append",
          audio: "AAAAAA==",
        });
        yield* Queue.offer(
          up.input,
          JSON.stringify({
            type: "response.created",
            response: { id: "resp_1", metadata: { voice_turn: "turn_1", key: "never-forward" } },
          }),
        );
        assert.equal((yield* Queue.take(down.output)).includes("never-forward"), false);
        yield* Queue.offer(
          down.input,
          JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output" },
          }),
        );
        const result = yield* Fiber.join(fiber).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }),
    ).pipe(Effect.timeout("2 seconds")),
  );
  assert.equal(
    peers.every((p) => p.closed()),
    true,
  );
});

test("relay acquires the lazy upstream reader before writing session configuration", async () => {
  const wire = new Wire();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const down = yield* peer;
        const up = yield* Socket.fromWebSocket(
          Effect.acquireRelease(Effect.succeed(wire as unknown as WebSocket), () =>
            Effect.sync(() => wire.close()),
          ),
        );
        const fiber = yield* relayVoiceSockets(
          down.socket,
          up,
          sessionUpdate("alloy", ""),
          Effect.never,
        ).pipe(Effect.forkScoped);
        assert.deepEqual(JSON.parse(yield* Queue.take(down.output)), { type: "relay.ready" });
        assert.equal(JSON.parse(wire.sent[0]!).type, "session.update");
        yield* Fiber.interrupt(fiber);
      }),
    ).pipe(Effect.timeout("2 seconds")),
  );
  assert.equal(wire.closed, true);
});

test("relay refuses audio before session acknowledgment", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const down = yield* peer,
          up = yield* peer;
        const fiber = yield* relayVoiceSockets(down.socket, up.socket, {}, Effect.never).pipe(
          Effect.forkScoped,
        );
        yield* Queue.take(up.output);
        yield* Queue.offer(down.input, JSON.stringify({ type: "input_audio_buffer.clear" }));
        assert.equal((yield* Fiber.join(fiber).pipe(Effect.result))._tag, "Failure");
      }),
    ).pipe(Effect.timeout("2 seconds")),
  );
});
