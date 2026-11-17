import { requestRecordingPermissionsAsync } from "expo-audio";
import * as Crypto from "expo-crypto";
import { nativeVoiceMedia, type NativeVoiceAudio } from "./voiceConversationAudio";

// iOS Live remains deferred; do not load or activate the custom audio engine.
const native: NativeVoiceAudio | null = null;
export const nativeVoiceAvailable = false;
export const createNativeVoiceMedia = nativeVoiceMedia(
  native,
  requestRecordingPermissionsAsync,
  Crypto.randomUUID,
);

/** Shared core uses Web Crypto UUIDs; Hermes needs Expo's secure implementation. */
export function prepareVoiceCrypto(): void {
  if (!globalThis.crypto)
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  if (!globalThis.crypto.getRandomValues)
    Object.defineProperty(globalThis.crypto, "getRandomValues", { value: Crypto.getRandomValues });
  if (!globalThis.crypto.randomUUID)
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: Crypto.randomUUID });
}
