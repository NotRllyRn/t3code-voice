import type { PlayedAudio, VoiceMediaFactory } from "@t3tools/client-runtime/voice-conversation";
import { deadline } from "@t3tools/client-runtime/voice-conversation";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../lib/audioSession";

export interface NativeVoiceAudio {
  open(id: string): void;
  capture(id: string, epoch: number): void;
  finishCapture(id: string, epoch: number): number;
  ackCapture(id: string, sequence: number): void;
  mute(id: string): void;
  allow(id: string, epoch: number): void;
  enqueue(id: string, epoch: number, item: string, index: number, pcm: string): void;
  silence(id: string): PlayedAudio | null;
  close(id: string): void;
  addListener(event: "capture", listener: (event: CaptureEvent) => void): { remove(): void };
  addListener(
    event: "failure",
    listener: (event: { id: string; message: string }) => void,
  ): { remove(): void };
}
interface CaptureEvent {
  id: string;
  epoch: number;
  sequence: number;
  samples: number;
  audio: string;
}

/** Only hardware/bridge ownership lives here. The accepted shared controller owns the protocol. */
export function nativeVoiceMedia(
  native: NativeVoiceAudio | null,
  permission: () => Promise<{ granted: boolean }>,
  uuid: () => string,
): VoiceMediaFactory {
  return async (options) => {
    if (!native) throw new Error("Rebuild the iOS client to use voice");
    const id = uuid();
    let disposed = false;
    let captureEpoch = 0;
    let outputEpoch = 0;
    let capturing = false;
    let muted = false;
    let received = 0;
    let drain: (() => void) | undefined;
    const subscriptions: { remove(): void }[] = [];
    const token = acquireAudioSession("conversation", () => {
      dispose();
      options.fail("Voice audio was taken by another recorder");
    });
    function dispose() {
      if (disposed) return;
      disposed = true;
      capturing = false;
      captureEpoch++;
      outputEpoch++;
      // Synchronous hardware gate, before any asynchronous session release.
      native!.close(id);
      for (const subscription of subscriptions) subscription.remove();
      drain?.();
      void releaseAudioSession(token).catch(() => {});
    }
    options.own(dispose);
    const alive = () => !disposed && options.alive();
    const fail = (message: string) => {
      dispose();
      options.fail(message);
    };
    subscriptions.push(
      native.addListener("failure", (event) => {
        if (event.id === id && alive()) fail(event.message);
      }),
    );
    subscriptions.push(
      native.addListener("capture", (event) => {
        if (event.id !== id || disposed) return;
        try {
          if (event.sequence !== received + 1) throw new Error("Capture event order changed");
          if (alive() && capturing && !muted && event.epoch === captureEpoch) {
            options.capture(event.audio, event.samples);
          }
          received = event.sequence;
          drain?.();
        } catch {
          fail("Voice capture stalled; conversation stopped");
        } finally {
          native.ackCapture(id, event.sequence);
        }
      }),
    );
    try {
      const granted = await permission();
      if (!alive()) throw new Error("Voice owner expired");
      if (!granted.granted) throw new Error("Microphone permission is required");
      if (
        !(await activateAudioSession(token, false, () => {
          if (alive()) native.open(id);
        })) ||
        !alive()
      )
        throw new Error("Voice audio owner changed");
      return {
        capture(enabled) {
          if (!alive()) return;
          capturing = enabled && !muted;
          if (capturing) native.capture(id, ++captureEpoch);
          else native.mute(id);
        },
        async finishCapture() {
          if (!alive()) return;
          const epoch = captureEpoch;
          const expected = native.finishCapture(id, epoch);
          // Events and native function results use different bridge channels. Wait for the
          // final sequence, not just the synchronous converter drain, before core commits.
          await deadline(
            new Promise<void>((resolve) => {
              const check = () => {
                if (!alive() || received >= expected) resolve();
              };
              drain = check;
              check();
            }),
            2000,
            "Native capture drain timed out",
          ).finally(() => {
            drain = undefined;
          });
          if (!alive()) throw new Error("Voice stopped during capture drain");
          if (epoch === captureEpoch) capturing = false;
        },
        mute(value) {
          muted = value;
          if (value) {
            capturing = false;
            captureEpoch++;
            native.mute(id);
          }
        },
        allow() {
          if (alive()) native.allow(id, ++outputEpoch);
        },
        enqueue(event) {
          if (alive())
            native.enqueue(id, outputEpoch, event.item_id, event.content_index, event.delta);
        },
        silence() {
          outputEpoch++;
          return Promise.resolve(disposed ? null : native.silence(id));
        },
        dispose,
      };
    } catch (error) {
      dispose();
      throw error;
    }
  };
}
