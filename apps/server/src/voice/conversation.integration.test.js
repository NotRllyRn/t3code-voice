// JS keeps this runtime-only check across the web/server TS project boundary.
// In-memory Effect sockets exercise the real relay and client without dialing upstream.
import * as NodeAssert from "node:assert/strict";
import { it as test } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import { relayVoiceSockets } from "./relay.ts";
import { Conversation } from "../../../web/src/voice/conversation.ts";
import { decodePCM, playedItem } from "../../../web/src/voice/pcm.js";

const peer = Effect.gen(function* () {
  const input = yield* Queue.unbounded();
  const output = yield* Queue.unbounded();
  let closed = false;
  let receive = (_event) => {};
  const socket = Socket.make({
    reader: Effect.acquireRelease(
      Effect.succeed({
        pull: Queue.take(input).pipe(Effect.map((frame) => [frame])),
        upgrade: () => Effect.void,
      }),
      () =>
        Effect.sync(() => {
          closed = true;
        }),
    ),
    writer: Effect.succeed({
      write: (frame) =>
        Effect.sync(() => {
          receive(JSON.parse(String(frame)));
          Queue.offerUnsafe(output, String(frame));
        }),
      writeAll: (frames) =>
        Effect.sync(() => {
          for (const frame of frames) {
            receive(JSON.parse(String(frame)));
            Queue.offerUnsafe(output, String(frame));
          }
        }),
    }),
  });
  return {
    socket,
    input,
    output,
    receive: (fn) => {
      receive = fn;
    },
    closed: () => closed,
  };
});

test.effect.each(["completed", "done-before-flush", "flush-before-done", "pending-identity"])(
  "real relay and client interrupt %s without stale playback or a guessed cancel",
  (order) =>
    Effect.gen(function* () {
      let peers = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const down = yield* peer,
            up = yield* peer;
          peers = [down, up];
          const flushed = Promise.withResolvers();
          let silenced = false,
            enqueued = 0;
          const timeline = [];
          const conversation = new Conversation(
            (event) => {
              Queue.offerUnsafe(down.input, JSON.stringify(event));
            },
            {
              allow: () => {},
              silence: () => {
                silenced = true;
                return flushed.promise;
              },
              enqueue: (event) => {
                enqueued++;
                timeline.push({
                  itemId: event.item_id,
                  contentIndex: event.content_index,
                  samples: decodePCM(event.delta).length,
                });
              },
            },
            (message) => {
              throw new Error(message);
            },
          );
          down.receive((event) => conversation.event(event));
          const fiber = yield* relayVoiceSockets(down.socket, up.socket, {}, Effect.never).pipe(
            Effect.forkScoped,
          );
          yield* Queue.take(up.output);
          const receive = Effect.fn("test.receiveVoiceEvent")(function* (event) {
            yield* Queue.offer(up.input, JSON.stringify(event));
            return JSON.parse(yield* Queue.take(down.output));
          });
          yield* receive({ type: "session.updated" });
          conversation.createResponse();
          const request = JSON.parse(yield* Queue.take(up.output));
          const created = {
            type: "response.created",
            response: { id: "response_old", metadata: request.response.metadata },
          };
          const done = {
            type: "response.done",
            response: {
              id: "response_old",
              status: order === "completed" ? "completed" : "cancelled",
            },
          };
          const audio = {
            type: "response.output_audio.delta",
            response_id: "response_old",
            item_id: "audio_old",
            content_index: 2,
            delta: Buffer.alloc(4800).toString("base64"),
          };
          const part = { ...audio, type: "response.content_part.added", part: { type: "audio" } };
          if (order !== "pending-identity") {
            yield* receive(created);
            yield* receive(part);
            yield* receive(audio);
          }
          if (order === "completed") yield* receive(done);
          const interrupting = conversation.interrupt();
          let settled = false;
          void interrupting.then(() => {
            settled = true;
          });
          NodeAssert.equal(silenced, true);
          if (order === "pending-identity") {
            // The pending barrier rejects another create without guessing the old response ID.
            NodeAssert.throws(() => conversation.createResponse());
            NodeAssert.equal(Queue.takeUnsafe(up.output), undefined);
            yield* receive(created);
            yield* receive(part);
          }
          if (order !== "completed")
            NodeAssert.deepEqual(JSON.parse(yield* Queue.take(up.output)), {
              type: "response.cancel",
              response_id: "response_old",
            });
          else NodeAssert.equal(Queue.takeUnsafe(up.output), undefined);
          yield* receive(audio);
          NodeAssert.equal(enqueued, order === "pending-identity" ? 0 : 1);
          if (order === "done-before-flush" || order === "pending-identity") yield* receive(done);
          NodeAssert.equal(settled, false);
          const played = playedItem(timeline, 1200, 240);
          flushed.resolve(played);
          const truncate = JSON.parse(yield* Queue.take(up.output));
          NodeAssert.deepEqual(truncate, {
            type: "conversation.item.truncate",
            item_id: "audio_old",
            content_index: 2,
            audio_end_ms: order === "pending-identity" ? 0 : 40,
          });
          if (order === "flush-before-done") {
            NodeAssert.equal(settled, false);
            NodeAssert.throws(() => conversation.createResponse());
            yield* receive(done);
          }
          yield* Effect.promise(() => interrupting);
          conversation.createResponse();
          const fresh = JSON.parse(yield* Queue.take(up.output));
          yield* receive({
            type: "response.created",
            response: { id: "response_new", metadata: fresh.response.metadata },
          });
          yield* Queue.offer(
            up.input,
            JSON.stringify({
              type: "conversation.item.truncated",
              item_id: "audio_old",
              content_index: 2,
              audio_end_ms: truncate.audio_end_ms,
            }),
          );
          yield* Queue.offer(
            up.input,
            JSON.stringify({ type: "response.output_audio.done", response_id: "response_old" }),
          );
          yield* receive(done);
          yield* receive(audio);
          NodeAssert.equal(enqueued, order === "pending-identity" ? 0 : 1);
          NodeAssert.throws(() => conversation.createResponse(), /still active/);
          yield* receive({ ...audio, response_id: "response_new", item_id: "audio_new" });
          NodeAssert.equal(enqueued, order === "pending-identity" ? 1 : 2);
          NodeAssert.equal(Queue.takeUnsafe(up.output), undefined);
          yield* receive({
            type: "response.done",
            response: { id: "response_new", status: "completed" },
          });
          conversation.close();
          yield* Fiber.interrupt(fiber);
        }),
      );
      NodeAssert.equal(
        peers.every((p) => p.closed()),
        true,
      );
    }),
);
