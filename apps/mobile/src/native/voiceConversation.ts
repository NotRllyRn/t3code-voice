import type { VoiceMediaFactory } from "@t3tools/client-runtime/voice-conversation";
export const nativeVoiceAvailable = false;
export const createNativeVoiceMedia: VoiceMediaFactory = async () => {
  throw new Error("Native conversation voice is available only on iOS");
};
export function prepareVoiceCrypto(): void {}
