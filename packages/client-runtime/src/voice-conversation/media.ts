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
  capture(enabled: boolean): void;
  finishCapture(): Promise<void>;
  allow(): void;
  silence(): Promise<PlayedAudio | null>;
  enqueue(event: AudioEvent): void;
  /** Resolve after queued audio is consumed; flush/teardown must release pending waits. */
  drain?(): Promise<void>;
  mute(muted: boolean): void;
  /** Gate hardware immediately; cleanup is idempotent, including after a late grant. */
  dispose(): void | Promise<unknown>;
}
export interface VoiceMediaOptions {
  /** Register cleanup before awaiting permission or acquiring resources. */
  own: (finalizer: () => unknown) => unknown;
  alive: () => boolean;
  fail: (message: string) => void;
  capture: (audio: string, samples: number) => void;
}
export type VoiceMediaFactory = (options: VoiceMediaOptions) => Promise<VoiceMedia>;

export interface VoiceSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "close" | "error", listener: () => void): void;
}
