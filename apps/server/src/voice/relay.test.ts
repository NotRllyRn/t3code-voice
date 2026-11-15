import * as NodeAssert from "node:assert/strict";
import { it as test } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Logger from "effect/Logger";
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

test.effect(
  "relay configures server-owned session, gates ready, relays audio, rejects tools, and releases readers",
  () =>
    Effect.gen(function* () {
      let peers: Array<{ closed: () => boolean }> = [];
      yield* Effect.scoped(
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
          NodeAssert.equal(setup.type, "session.update");
          NodeAssert.deepEqual(setup.session.tools, []);
          yield* Queue.offer(
            up.input,
            JSON.stringify({ type: "session.updated", secret: "never-forward" }),
          );
          NodeAssert.deepEqual(JSON.parse(yield* Queue.take(down.output)), { type: "relay.ready" });
          yield* Queue.offer(
            down.input,
            JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAAAA==" }),
          );
          NodeAssert.deepEqual(JSON.parse(yield* Queue.take(up.output)), {
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
          NodeAssert.equal((yield* Queue.take(down.output)).includes("never-forward"), false);
          yield* Queue.offer(
            down.input,
            JSON.stringify({
              type: "conversation.item.create",
              item: { type: "function_call_output" },
            }),
          );
          const result = yield* Fiber.join(fiber).pipe(Effect.result);
          NodeAssert.equal(result._tag, "Failure");
        }),
      ).pipe(Effect.timeout("2 seconds"));
      NodeAssert.equal(
        peers.every((p) => p.closed()),
        true,
      );
    }),
);

test.effect("relay acquires the lazy upstream reader before writing session configuration", () =>
  Effect.gen(function* () {
    const wire = new Wire();
    yield* Effect.scoped(
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
        NodeAssert.deepEqual(JSON.parse(yield* Queue.take(down.output)), { type: "relay.ready" });
        NodeAssert.equal(JSON.parse(wire.sent[0]!).type, "session.update");
        yield* Fiber.interrupt(fiber);
      }),
    ).pipe(Effect.timeout("2 seconds"));
    NodeAssert.equal(wire.closed, true);
  }),
);

test.effect.each([
  { eventType: "error", code: "response_cancel_not_active" },
  { eventType: "error", code: "server_error" },
  { eventType: "error", code: "server_error", staleDone: true },
  { eventType: "error", code: "Bearer fictional-secret" },
  { eventType: "response.done", code: "server_error" },
  { eventType: "conversation.item.input_audio_transcription.failed", code: "invalid_value" },
])(
  "relay keeps upstream failure $eventType fatal with safe diagnostics",
  ({ eventType, code, staleDone }) =>
    Effect.gen(function* () {
      const logs: unknown[] = [];
      let peers: Array<{ closed: () => boolean }> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const down = yield* peer,
            up = yield* peer;
          peers = [down, up];
          const fiber = yield* relayVoiceSockets(down.socket, up.socket, {}, Effect.never).pipe(
            Effect.forkScoped,
          );
          yield* Queue.take(up.output);
          yield* Queue.offer(up.input, JSON.stringify({ type: "session.updated" }));
          yield* Queue.take(down.output);
          const receive = (event: object) => Queue.offer(up.input, JSON.stringify(event));
          yield* receive({ type: "response.created", response: { id: "private-response-id" } });
          yield* Queue.take(down.output);
          yield* receive({
            type: "response.done",
            response: {
              id: staleDone ? "private-stale-id" : "private-response-id",
              status: "completed",
            },
          });
          yield* Queue.take(down.output);
          for (const command of [
            { type: "response.cancel", response_id: "private-response-id" },
            {
              type: "conversation.item.truncate",
              item_id: "private-item-id",
              content_index: 2,
              audio_end_ms: 40,
            },
          ]) {
            yield* Queue.offer(down.input, JSON.stringify(command));
            yield* Queue.take(up.output);
          }
          const error = {
            code,
            type: "fictional-secret",
            message: "fictional-secret",
            param: "fictional-secret",
            event_id: "private-event-id",
            request_body: { token: "fictional-secret" },
          };
          yield* receive({
            type: eventType,
            event_id: "private-event-id",
            error,
            response: { id: "private-response-id", status: "failed", status_details: { error } },
          });
          NodeAssert.equal((yield* Fiber.join(fiber).pipe(Effect.result))._tag, "Failure");
          NodeAssert.deepEqual(logs, [
            [
              "Voice relay failed",
              {
                upstreamFailureEvent: eventType,
                upstreamErrorCode: code === "Bearer fictional-secret" ? "other" : code,
                lastClientEvent: "conversation.item.truncate",
                lastServerEvent: "response.done",
                responsePending: false,
                responseGenerating: !!staleDone,
                responsesCreated: 1,
                responsesDone: 1,
                cancelRequests: 1,
                cancelWithoutObservedActiveResponse: staleDone ? 0 : 1,
                truncateRequests: 1,
              },
            ],
          ]);
          NodeAssert.equal(JSON.stringify(logs).includes("fictional-secret"), false);
          NodeAssert.equal(JSON.stringify(logs).includes("private-"), false);
        }),
      ).pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logs.push(message))], {
            mergeWithExisting: false,
          }),
        ),
      );
      NodeAssert.equal(
        peers.every((p) => p.closed()),
        true,
      );
    }),
);

test.effect(
  "continuous relay keeps function calls and playback ACK local to the bridge and rejects client response ownership",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const down = yield* peer,
          up = yield* peer;
        const received = yield* Queue.unbounded<Record<string, unknown>>();
        const fiber = yield* relayVoiceSockets(
          down.socket,
          up.socket,
          sessionUpdate("alloy", "whisper-1", true),
          Effect.never,
          () =>
            Effect.succeed({
              receive: (event) => Queue.offer(received, event).pipe(Effect.asVoid),
              run: Effect.never,
            }),
        ).pipe(Effect.forkScoped);
        const setup = JSON.parse(yield* Queue.take(up.output));
        NodeAssert.equal(setup.session.audio.input.turn_detection.create_response, false);
        NodeAssert.equal(setup.session.tools[0].name, "run_t3_agent");
        yield* Queue.offer(up.input, JSON.stringify({ type: "session.updated" }));
        yield* Queue.take(down.output);
        yield* Queue.take(received);
        yield* Queue.offer(
          up.input,
          JSON.stringify({
            type: "response.function_call_arguments.done",
            response_id: "resp_1",
            call_id: "call_1",
            name: "run_t3_agent",
            arguments: "{}",
          }),
        );
        NodeAssert.equal(
          (yield* Queue.take(received)).type,
          "response.function_call_arguments.done",
        );
        NodeAssert.equal(yield* Queue.size(down.output), 0);
        yield* Queue.offer(
          down.input,
          JSON.stringify({ type: "relay.playback.done", response_id: "resp_1" }),
        );
        NodeAssert.deepEqual(yield* Queue.take(received), {
          type: "relay.playback.done",
          response_id: "resp_1",
        });
        yield* Queue.offer(down.input, JSON.stringify({ type: "input_audio_buffer.clear" }));
        NodeAssert.deepEqual(JSON.parse(yield* Queue.take(up.output)), {
          type: "input_audio_buffer.clear",
        });
        yield* Queue.offer(
          down.input,
          JSON.stringify({
            type: "response.create",
            response: {
              output_modalities: ["audio"],
              max_output_tokens: 512,
              metadata: { voice_turn: "unowned" },
            },
          }),
        );
        NodeAssert.equal((yield* Fiber.join(fiber).pipe(Effect.result))._tag, "Failure");
      }),
    ).pipe(Effect.timeout("2 seconds")),
);

test.effect("relay refuses audio before session acknowledgment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const down = yield* peer,
        up = yield* peer;
      const fiber = yield* relayVoiceSockets(down.socket, up.socket, {}, Effect.never).pipe(
        Effect.forkScoped,
      );
      yield* Queue.take(up.output);
      yield* Queue.offer(down.input, JSON.stringify({ type: "input_audio_buffer.clear" }));
      NodeAssert.equal((yield* Fiber.join(fiber).pipe(Effect.result))._tag, "Failure");
    }),
  ).pipe(Effect.timeout("2 seconds")),
);
