import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import {
  clientEvent,
  MAX_FRAME_BYTES,
  MAX_SESSION_MS,
  serverEvent,
  VoiceBudget,
} from "./protocol.ts";

const parseFrame = (frame: string | Uint8Array): unknown => {
  if (typeof frame !== "string" || Buffer.byteLength(frame) > MAX_FRAME_BYTES)
    throw Error("Invalid voice frame");
  return JSON.parse(frame);
};

/** Both peers and their readers are scoped by the caller. Backpressure, not unbounded queues. */
export const relayVoiceSockets = Effect.fn("voice.relay")(function* (
  downstream: Socket.Socket,
  upstream: Socket.Socket,
  update: object,
  watchOwner: Effect.Effect<never, unknown>,
) {
  // Effect WebSockets are lazy: reader acquisition opens the transport and
  // releases writers. Writing session.update before this would deadlock.
  const clientReader = yield* downstream.reader;
  const upstreamReader = yield* upstream.reader;
  const toClient = yield* downstream.writer;
  const toUpstream = yield* upstream.writer;
  const budget = new VoiceBudget();
  let ready = false;
  const pump = (
    reader: Socket.Reader,
    receive: (frame: string | Uint8Array) => Effect.Effect<unknown, unknown>,
  ) =>
    Effect.gen(function* () {
      while (true) {
        const frames = yield* reader.pull;
        for (const frame of frames) yield* receive(frame);
      }
    });
  yield* toUpstream.write(JSON.stringify(update));
  const fromClient = pump(clientReader, (frame) =>
    Effect.gen(function* () {
      const e = yield* Effect.try(() => clientEvent(parseFrame(frame)));
      if (!ready) return yield* Effect.fail(new Error("Voice session is not ready"));
      yield* Effect.try(() => budget.accept(e));
      yield* toUpstream.write(JSON.stringify(e));
    }),
  );
  const fromUpstream = pump(upstreamReader, (frame) =>
    Effect.gen(function* () {
      const event = yield* Effect.try(() => serverEvent(parseFrame(frame)));
      if (event?.type === "relay.ready") ready = true;
      if (event) yield* toClient.write(JSON.stringify(event));
    }),
  );
  const handshakeTimeout = Effect.sleep("10 seconds").pipe(
    Effect.flatMap(() =>
      ready ? Effect.never : Effect.fail(new Error("Voice upstream did not become ready")),
    ),
  );
  yield* Effect.raceFirst(
    Effect.raceFirst(fromClient, fromUpstream),
    Effect.raceFirst(watchOwner, handshakeTimeout),
  ).pipe(Effect.timeoutOrElse({ duration: MAX_SESSION_MS, orElse: () => Effect.void }));
});
