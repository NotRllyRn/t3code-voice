import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import {
  clientEvent,
  MAX_FRAME_BYTES,
  MAX_SESSION_MS,
  serverEvent,
  VoiceBudget,
} from "./protocol.ts";

export class VoiceRelayError extends Schema.TaggedError<VoiceRelayError>()("VoiceRelayError", {}) {}
const json = Schema.fromJsonString(Schema.Unknown);
export const encodeVoiceFrame = Schema.encodeEffect(json);
const decode = Schema.decodeUnknownEffect(json);
const parseFrame = Effect.fn("voice.parseFrame")(function* (frame: string | Uint8Array) {
  if (typeof frame !== "string" || Buffer.byteLength(frame) > MAX_FRAME_BYTES)
    return yield* Effect.fail(new VoiceRelayError());
  return yield* decode(frame);
});
const pump = Effect.fn("voice.pump")(function* <E>(
  reader: Socket.Reader,
  receive: (frame: string | Uint8Array) => Effect.Effect<void, E>,
) {
  while (true) {
    const frames = yield* reader.pull;
    for (const frame of frames) yield* receive(frame);
  }
});

/** The caller supplies bounded transports and scopes both peers. */
export const relayVoiceSockets = Effect.fn("voice.relay")(function* <E>(
  downstream: Socket.Socket,
  upstream: Socket.Socket,
  update: object,
  watchOwner: Effect.Effect<never, E>,
) {
  // Reader acquisition opens Effect's lazy WebSocket and releases its writers.
  const clientReader = yield* downstream.reader;
  const upstreamReader = yield* upstream.reader;
  const toClient = yield* downstream.writer;
  const toUpstream = yield* upstream.writer;
  const budget = new VoiceBudget();
  let ready = false;
  yield* toUpstream.write(yield* encodeVoiceFrame(update));
  const fromClient = pump(clientReader, (frame) =>
    Effect.gen(function* () {
      const value = yield* parseFrame(frame);
      const e = yield* Effect.try({
        try: () => clientEvent(value),
        catch: () => new VoiceRelayError(),
      });
      if (!ready) return yield* Effect.fail(new VoiceRelayError());
      yield* Effect.try({ try: () => budget.accept(e), catch: () => new VoiceRelayError() });
      yield* toUpstream.write(yield* encodeVoiceFrame(e));
    }),
  );
  const fromUpstream = pump(upstreamReader, (frame) =>
    Effect.gen(function* () {
      const value = yield* parseFrame(frame);
      const event = yield* Effect.try({
        try: () => serverEvent(value),
        catch: () => new VoiceRelayError(),
      });
      if (event?.type === "relay.ready") ready = true;
      if (event) yield* toClient.write(yield* encodeVoiceFrame(event));
    }),
  );
  const handshakeTimeout = Effect.sleep("10 seconds").pipe(
    Effect.flatMap(() => (ready ? Effect.never : Effect.fail(new VoiceRelayError()))),
  );
  yield* Effect.raceFirst(
    Effect.raceFirst(fromClient, fromUpstream),
    Effect.raceFirst(watchOwner, handshakeTimeout),
  ).pipe(Effect.timeoutOrElse({ duration: MAX_SESSION_MS, orElse: () => Effect.void }));
});
