// @effect-diagnostics-next-line nodeBuiltinImport:off -- ws upgrade hooks require Node's Duplex type.
import type * as NodeStream from "node:stream";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { MAX_FRAME_BYTES } from "./protocol.ts";

export const MAX_BUFFER_BYTES = 256 * 1024;
export const MAX_BUFFER_FRAMES = 256;
export class VoiceTransportError extends Schema.TaggedError<VoiceTransportError>()(
  "VoiceTransportError",
  {},
) {}

interface Guard {
  bytes: number;
  frames: number;
  failed: boolean;
}
const guards = new WeakMap<NodeWS.WebSocket, Guard>();
const pending = new WeakMap<NodeStream.Duplex, (ws: VoiceWebSocket) => void>();
const size = (frame: string | Uint8Array) =>
  typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
const fail = (ws: NodeWS.WebSocket, guard: Guard) => {
  guard.failed = true;
  ws.terminate();
};

// NodeHttpServer hides its ws instance. This ws 8.x hook captures only claimed voice upgrades
// before parsing head; all other application upgrades retain the platform's original settings.
export class VoiceWebSocket extends NodeWS.WebSocket {
  setSocket(socket: NodeStream.Duplex, head: Buffer, options: object) {
    const claim = pending.get(socket);
    if (claim) {
      pending.delete(socket);
      guards.set(this, { bytes: 0, frames: 0, failed: false });
      claim(this);
    }
    const base = NodeWS.WebSocket.prototype as unknown as {
      setSocket(socket: NodeStream.Duplex, head: Buffer, options: object): void;
    };
    base.setSocket.call(
      this,
      socket,
      head,
      claim ? { ...options, maxPayload: MAX_FRAME_BYTES } : options,
    );
  }

  // ws responds to ping internally, outside Effect's writer. Bound that path too.
  override pong(...args: Parameters<NodeWS.WebSocket["pong"]>) {
    const guard = guards.get(this);
    if (guard && (guard.failed || this.bufferedAmount + 125 + 14 > MAX_BUFFER_BYTES)) {
      fail(this, guard);
      return;
    }
    return super.pong(...args);
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const guard = guards.get(this);
    if (event === "message" && guard) {
      const data = args[0];
      const bytes =
        typeof data === "string"
          ? Buffer.byteLength(data)
          : data instanceof Uint8Array
            ? data.byteLength
            : MAX_FRAME_BYTES + 1;
      if (guard.failed) return false;
      if (
        bytes > MAX_FRAME_BYTES ||
        guard.bytes + bytes > MAX_BUFFER_BYTES ||
        guard.frames >= MAX_BUFFER_FRAMES
      ) {
        fail(this, guard);
        return false;
      }
      guard.bytes += bytes;
      guard.frames++;
    }
    return super.emit(event, ...args);
  }
}

export const claimVoiceUpgrade = (socket: NodeStream.Duplex) => {
  let wire: VoiceWebSocket | undefined;
  pending.set(socket, (ws) => {
    wire = ws;
  });
  return {
    wire: () => wire,
    close: () => {
      pending.delete(socket);
      wire?.terminate();
    },
  };
};

export const makeVoiceUpstream = (url: string, key: string) => {
  const ws = new VoiceWebSocket(url, {
    headers: { Authorization: `Bearer ${key}` },
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  guards.set(ws, { bytes: 0, frames: 0, failed: false });
  // A cancelled handshake emits error after Effect detaches its listeners.
  ws.on("error", () => undefined);
  return ws;
};

const transportError = () =>
  new Socket.SocketError({
    reason: new Socket.SocketWriteError({ cause: new VoiceTransportError() }),
  });

export const boundedVoiceSocket = (
  socket: Socket.Socket,
  wire: () => VoiceWebSocket | undefined,
) => {
  const write: Socket.Writer["write"] = (frame) =>
    Effect.try({
      try: () => {
        const ws = wire();
        const guard = ws && guards.get(ws);
        if (!ws || !guard || guard.failed || ws.readyState !== NodeWS.WebSocket.OPEN)
          throw new VoiceTransportError();
        if (Socket.isCloseEvent(frame)) {
          ws.close(frame.code);
          return;
        }
        // ws.bufferedAmount covers both sender/compression queues and TCP writableLength.
        // Uncompressed voice sends need at most 14 bytes of WebSocket framing overhead.
        if (
          size(frame) > MAX_FRAME_BYTES ||
          ws.bufferedAmount + size(frame) + 14 > MAX_BUFFER_BYTES
        ) {
          fail(ws, guard);
          throw new VoiceTransportError();
        }
        ws.send(frame, { compress: false });
        if (ws.bufferedAmount > MAX_BUFFER_BYTES) {
          fail(ws, guard);
          throw new VoiceTransportError();
        }
      },
      catch: transportError,
    });
  return Socket.make({
    reader: Effect.gen(function* () {
      const reader = yield* socket.reader;
      const ws = wire();
      const guard = ws && guards.get(ws);
      if (!ws || !guard) return yield* transportError();
      return {
        ...reader,
        pull: Effect.suspend(() =>
          guard.failed ? Effect.fail(transportError()) : reader.pull,
        ).pipe(
          Effect.tap((frames) =>
            Effect.sync(() => {
              guard.bytes -= frames.reduce((total, frame) => total + size(frame), 0);
              guard.frames -= frames.length;
            }),
          ),
        ),
      };
    }),
    writer: Effect.succeed({
      write,
      writeAll: (frames) => Effect.forEach(frames, write, { discard: true }),
    }),
  });
};
