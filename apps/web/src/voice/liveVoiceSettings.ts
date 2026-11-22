import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "../lib/storage";

import {
  DEFAULT_LIVE_VOICE_PREFERENCES,
  LIVE_VOICE_VOICES,
  type LiveVoicePreferences,
} from "@t3tools/contracts";

export const liveVoices = LIVE_VOICE_VOICES;
type LiveVoiceSettings = LiveVoicePreferences & {
  microphoneId: string;
  speakerId: string;
};
export const useLiveVoiceSettings = create<LiveVoiceSettings>()(
  persist(
    () => ({
      ...DEFAULT_LIVE_VOICE_PREFERENCES,
      microphoneId: "",
      speakerId: "",
    }),
    {
      name: "t3code:live-voice-settings:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      merge: (persisted) => {
        const saved =
          persisted && typeof persisted === "object"
            ? (persisted as Partial<LiveVoiceSettings>)
            : {};
        return {
          voice:
            liveVoices.find((voice) => voice === saved.voice) ??
            DEFAULT_LIVE_VOICE_PREFERENCES.voice,
          notifications: saved.notifications === "progress" ? "progress" : "terminal",
          microphoneId: typeof saved.microphoneId === "string" ? saved.microphoneId : "",
          speakerId: typeof saved.speakerId === "string" ? saved.speakerId : "",
        };
      },
    },
  ),
);
