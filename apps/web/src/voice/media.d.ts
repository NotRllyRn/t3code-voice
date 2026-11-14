export interface PlayedAudio {
  itemId: string;
  contentIndex: number;
  ms: number;
}
export interface AudioEvent {
  delta: string;
  item_id: string;
  content_index: number;
}
export interface VoiceMedia {
  context: AudioContext;
  capture(enabled: boolean): void;
  finishCapture(): Promise<void>;
  allow(): void;
  silence(): Promise<PlayedAudio | null>;
  enqueue(event: AudioEvent): void;
}
export function pcmMedia(
  stream: MediaStream,
  options: {
    own: (finalizer: () => unknown) => unknown;
    alive: () => boolean;
    fail: (message: string) => void;
    capture: (audio: string, samples: number) => void;
  },
): Promise<VoiceMedia>;
