import * as Socket from "effect/socket/Socket";

export const layer = Socket.layerWebSocketConstructorGlobal;
export const voiceSocketAvailable = false;
export function createVoiceSocket(
  _url: string,
): import("@t3tools/client-runtime/voice-conversation").VoiceSocket {
  throw new Error("Native conversation voice is available only on iOS");
}
