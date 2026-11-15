import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { VoiceAgentError, type VoiceAgentConnection } from "./agentSession.ts";
import {
  clientEvent,
  MAX_FRAME_BYTES,
  MAX_SESSION_MS,
  object,
  serverEvent,
  VoiceBudget,
} from "./protocol.ts";

export class VoiceRelayError extends Schema.TaggedError<VoiceRelayError>()("VoiceRelayError", {}) {}
const json = Schema.fromJsonString(Schema.Unknown);
export const encodeVoiceFrame = Schema.encodeEffect(json);
const decode = Schema.decodeUnknownEffect(json);
const parseFrame = Effect.fn("voice.parseFrame")(function* (frame: string | Uint8Array) {
  if (typeof frame !== "string" || Buffer.byteLength(frame) > MAX_FRAME_BYTES)
    return yield* new VoiceRelayError();
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
export const relayVoiceSockets = Effect.fn("voice.relay")(function* <E, R = never>(
  downstream: Socket.Socket,
  upstream: Socket.Socket,
  update: object,
  watchOwner: Effect.Effect<never, E>,
  makeAgent?: (
    up: (event: object) => Effect.Effect<void, VoiceAgentError>,
    down: (event: object) => Effect.Effect<void, VoiceAgentError>,
  ) => Effect.Effect<VoiceAgentConnection, VoiceAgentError, R>,
) {
  // Reader acquisition opens Effect's lazy WebSocket and releases its writers.
  const clientReader = yield* downstream.reader;
  const upstreamReader = yield* upstream.reader;
  const toClient = yield* downstream.writer;
  const toUpstream = yield* upstream.writer;
  const agent = makeAgent
    ? yield* makeAgent(
        (event) =>
          encodeVoiceFrame(event).pipe(
            Effect.flatMap((frame) => toUpstream.write(frame)),
            Effect.mapError(() => new VoiceAgentError()),
          ),
        (event) =>
          encodeVoiceFrame(event).pipe(
            Effect.flatMap((frame) => toClient.write(frame)),
            Effect.mapError(() => new VoiceAgentError()),
          ),
      ).pipe(Effect.mapError(() => new VoiceRelayError()))
    : undefined;
  const budget = new VoiceBudget(!!agent);
  let ready = false;
  let responseId: unknown;
  const diagnostics = {
    upstreamFailureEvent: "none",
    upstreamErrorCode: "none",
    lastClientEvent: "none",
    lastServerEvent: "none",
    responsePending: false,
    responseGenerating: false,
    responsesCreated: 0,
    responsesDone: 0,
    cancelRequests: 0,
    cancelWithoutObservedActiveResponse: 0,
    truncateRequests: 0,
  };
  yield* toUpstream.write(yield* encodeVoiceFrame(update));
  const fromClient = pump(clientReader, (frame) =>
    Effect.gen(function* () {
      const value = yield* parseFrame(frame);
      const e = yield* Effect.try({
        try: () => clientEvent(value),
        catch: () => new VoiceRelayError(),
      });
      if (
        !ready ||
        (agent && ["response.create", "input_audio_buffer.commit"].includes(String(e.type)))
      )
        return yield* new VoiceRelayError();
      yield* Effect.try({ try: () => budget.accept(e), catch: () => new VoiceRelayError() });
      if (e.type === "relay.playback.done") {
        if (!agent) return yield* new VoiceRelayError();
        yield* agent.receive(e);
        return;
      }
      diagnostics.lastClientEvent = String(e.type);
      if (e.type === "response.create") diagnostics.responsePending = true;
      if (e.type === "response.cancel") {
        diagnostics.cancelRequests++;
        if (!diagnostics.responseGenerating || e.response_id !== responseId)
          diagnostics.cancelWithoutObservedActiveResponse++;
      }
      if (e.type === "conversation.item.truncate") diagnostics.truncateRequests++;
      yield* toUpstream.write(yield* encodeVoiceFrame(e));
    }),
  );
  const fromUpstream = pump(upstreamReader, (frame) =>
    Effect.gen(function* () {
      const value = yield* parseFrame(frame);
      const raw = object(value);
      const response = object(raw.response);
      if (
        raw.type === "error" ||
        (raw.type === "response.done" && response.status === "failed") ||
        raw.type === "conversation.item.input_audio_transcription.failed"
      ) {
        diagnostics.upstreamFailureEvent = raw.type;
        const code = object(
          raw.type === "response.done" ? object(response.status_details).error : raw.error,
        ).code;
        diagnostics.upstreamErrorCode =
          typeof code === "string" &&
          [
            "response_cancel_not_active",
            "invalid_value",
            "invalid_api_key",
            "rate_limit_exceeded",
            "server_error",
          ].includes(code)
            ? code
            : "other";
      }
      const event = yield* Effect.try({
        try: () => serverEvent(value),
        catch: () => new VoiceRelayError(),
      });
      if (event?.type === "relay.ready") ready = true;
      if (event) {
        diagnostics.lastServerEvent = String(event.type);
        if (event.type === "response.created") {
          responseId = object(event.response).id;
          diagnostics.responsePending = false;
          diagnostics.responseGenerating = true;
          diagnostics.responsesCreated++;
        }
        if (event.type === "response.done") {
          diagnostics.responsesDone++;
          if (object(event.response).id === responseId) diagnostics.responseGenerating = false;
        }
        yield* toClient.write(yield* encodeVoiceFrame(event));
      }
      if (agent) {
        if (raw.type === "input_audio_buffer.committed") budget.committed();
        yield* agent.receive(raw);
      }
    }),
  );
  const handshakeTimeout = Effect.sleep("10 seconds").pipe(
    Effect.flatMap(() => (ready ? Effect.never : Effect.fail(new VoiceRelayError()))),
  );
  yield* Effect.raceFirst(
    Effect.raceFirst(fromClient, fromUpstream),
    Effect.raceFirst(
      Effect.raceFirst(watchOwner, handshakeTimeout),
      agent ? agent.run.pipe(Effect.mapError(() => new VoiceRelayError())) : Effect.never,
    ),
  ).pipe(
    Effect.timeoutOrElse({ duration: MAX_SESSION_MS, orElse: () => Effect.void }),
    // Only fixed categories and local counters; never log a cause or provider payload.
    Effect.tapError(() => Effect.logWarning("Voice relay failed", { ...diagnostics })),
  );
});
