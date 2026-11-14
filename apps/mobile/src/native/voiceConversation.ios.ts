import { requireOptionalNativeModule } from "expo";
import { requestRecordingPermissionsAsync } from "expo-audio";
import * as Crypto from "expo-crypto";
import { nativeVoiceMedia, type NativeVoiceAudio } from "./voiceConversationAudio";

const native = requireOptionalNativeModule<NativeVoiceAudio>("T3VoiceConversation");
export const nativeVoiceAvailable = native !== null;
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
