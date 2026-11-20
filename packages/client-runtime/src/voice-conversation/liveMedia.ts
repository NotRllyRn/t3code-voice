import type { LiveVoiceReason } from "@t3tools/contracts";

export interface LiveMedia {
  offer(): Promise<string>;
  answer(sdp: string): Promise<void>;
  microphone(enabled: boolean): void;
  playback(enabled: boolean): Promise<void>;
  stopAudio(): void;
  dispose(): void;
}

export interface LiveMediaOptions {
  signal: AbortSignal;
  devices?: { microphoneId: string; speakerId: string };

  alive(): boolean;
  own(dispose: () => void): void;
  peer(state: "connected" | "failed"): void;
  fail(reason: LiveVoiceReason): void;
}

export type LiveMediaFactory = (options: LiveMediaOptions) => Promise<LiveMedia>;
