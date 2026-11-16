import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Socket from "effect/socket/Socket";
import type { ResolvedLiveConnection } from "@t3tools/provider-core/server/liveConnection";

export const connection: ResolvedLiveConnection = {
  createUrl: "https://relay.example.test/prefix/v1/live",
  revision: "fictional-private-revision",
  protocol: "cpa-codex-live",
  requestedModel: "gpt-live-1.1-codex",
  headers: Redacted.make({
    Authorization: "Bearer fictional-selected-key",
    "OpenAI-Alpha": "quicksilver=v2",
  }),
};
export const sdp =
  "v=0\r\no=- 42 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
export const peer = Effect.gen(function* () {
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
