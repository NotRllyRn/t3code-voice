import type {
  VoiceMedia,
  VoiceMediaFactory,
  VoiceMediaOptions,
} from "@t3tools/client-runtime/voice-conversation";

export const browserMedia: VoiceMediaFactory;
export function pcmMedia(
  stream: MediaStream,
  options: VoiceMediaOptions,
): Promise<Omit<VoiceMedia, "mute" | "dispose"> & { context: AudioContext }>;
