import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { VoiceMediaOptions } from "@t3tools/client-runtime/voice-conversation";

vi.mock("expo-audio", () => ({
  AudioModule: { setAudioSessionOwner: vi.fn() },
  setAudioModeAsync: vi.fn(async () => {}),
  setIsAudioActiveAsync: vi.fn(async () => {}),
}));
import { setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
  prepareOwnedAudioSession,
} from "../lib/audioSession";
import { nativeVoiceMedia, type NativeVoiceAudio } from "./voiceConversationAudio";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  await Promise.resolve();
  vi.clearAllMocks();
});

function setup(permission = async () => ({ granted: true }), id = "owner") {
  const listeners = new Map<string, (event: never) => void>();
  const native = {
    open: vi.fn(),
    capture: vi.fn(),
    finishCapture: vi.fn(() => 0),
    ackCapture: vi.fn(),
    mute: vi.fn(),
    allow: vi.fn(),
    enqueue: vi.fn(),
    silence: vi.fn(() => ({ itemId: "heard", contentIndex: 0, ms: 125 })),
    close: vi.fn(),
    addListener: vi.fn((event: string, listener: (event: never) => void) => {
      listeners.set(event, listener);
      return { remove: () => listeners.delete(event) };
    }),
  } satisfies NativeVoiceAudio;
  const options: VoiceMediaOptions = {
    own: (fn) => {
      cleanup.push(fn);
    },
    alive: () => true,
    fail: vi.fn(),
    capture: vi.fn(),
  };
  const emit = (type: string, value: object) => listeners.get(type)?.(value as never);
  const chunk = (sequence: number, epoch = 1) =>
    emit("capture", { id, sequence, epoch, audio: "AA==", samples: 1 });
  return {
    native,
    options,
    emit,
    chunk,
    start: () => nativeVoiceMedia(native, permission, () => id)(options),
  };
}

describe("native voice media adapter", () => {
  it("owns cleanup before permission and does not activate after a late permission grant", async () => {
    const grant = Promise.withResolvers<{ granted: boolean }>();
    const first = setup(() => grant.promise, "old");
    const pending = first.start();
    expect(cleanup).toHaveLength(1);
    cleanup[0]!();
    const next = setup(undefined, "new");
    await next.start();
    vi.mocked(setIsAudioActiveAsync).mockClear();
    grant.resolve({ granted: true });
    await expect(pending).rejects.toThrow(/expired/);
    expect(first.native.open).not.toHaveBeenCalled();
    expect(next.native.open).toHaveBeenCalledWith("new");
    expect(setIsAudioActiveAsync).not.toHaveBeenCalled();
  });

  it("uses the native duplex activation without Expo's recording-only mode", async () => {
    const { start, native } = setup();
    const media = await start();
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(setAudioModeAsync).not.toHaveBeenCalled();
    media.dispose();
    media.dispose();
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it("drains ordered capture events before finish resolves, including a late converter tail", async () => {
    const { start, native, chunk, options } = setup();
    const media = await start();
    media.capture(true);
    native.finishCapture.mockReturnValue(2);
    const done = vi.fn();
    const finishing = media.finishCapture().then(done);
    chunk(1);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    chunk(2);
    await finishing;
    expect(options.capture).toHaveBeenCalledTimes(2);
    expect(native.ackCapture.mock.calls).toEqual([
      ["owner", 1],
      ["owner", 2],
    ]);
    chunk(3);
    expect(options.capture).toHaveBeenCalledTimes(2);
  });

  it("rejects an unfinished drain after Stop instead of committing late capture", async () => {
    const { start, native, chunk, options } = setup();
    const media = await start();
    media.capture(true);
    native.finishCapture.mockReturnValue(1);
    const finishing = media.finishCapture();
    media.dispose();
    await expect(finishing).rejects.toThrow(/stopped during capture drain/);
    chunk(1);
    expect(options.capture).not.toHaveBeenCalled();
  });

  it("bounds a stalled capture finish with the existing two-second barrier", async () => {
    vi.useFakeTimers();
    try {
      const { start, native } = setup();
      const media = await start();
      media.capture(true);
      native.finishCapture.mockReturnValue(1);
      const result = expect(media.finishCapture()).rejects.toThrow(/drain timed out/);
      await vi.advanceTimersByTimeAsync(2000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops muted/old-epoch/other-owner capture while acknowledging its own ordered events", async () => {
    const { start, native, chunk, emit, options } = setup();
    const media = await start();
    media.capture(true);
    media.mute(true);
    chunk(1);
    media.mute(false);
    media.capture(true);
    chunk(2, 1);
    chunk(3, 3);
    emit("capture", { id: "old", sequence: 4, epoch: 3 });
    expect(options.capture).toHaveBeenCalledTimes(1);
    expect(native.ackCapture).toHaveBeenCalledTimes(3);
    media.dispose();
    chunk(4, 3);
    expect(options.capture).toHaveBeenCalledTimes(1);
  });

  it("gates and resets native output synchronously and returns native rendered position", async () => {
    const { start, native } = setup();
    const media = await start();
    media.allow();
    media.enqueue({ delta: "AA==", item_id: "heard", content_index: 0 });
    expect(native.enqueue).toHaveBeenCalledWith("owner", 1, "heard", 0, "AA==");
    const silence = media.silence();
    expect(native.silence).toHaveBeenCalledTimes(1);
    expect(await silence).toEqual({ itemId: "heard", contentIndex: 0, ms: 125 });
    media.allow();
    expect(native.allow).toHaveBeenLastCalledWith("owner", 3);
  });

  it("fails closed on a missing capture sequence and on native route/background failure", async () => {
    const first = setup();
    const media = await first.start();
    media.capture(true);
    first.chunk(2);
    expect(first.options.fail).toHaveBeenCalledWith(expect.stringContaining("stalled"));
    expect(first.native.close).toHaveBeenCalledTimes(1);
    const next = setup();
    await next.start();
    next.emit("failure", { id: "owner", message: "Route changed" });
    expect(next.native.close).toHaveBeenCalledTimes(1);
    expect(next.options.fail).toHaveBeenCalledWith("Route changed");
  });

  it("releases a denied permission and has no missing-module fallback", async () => {
    const { start, native } = setup(async () => ({ granted: false }));
    await expect(start()).rejects.toThrow(/permission/);
    expect(native.open).not.toHaveBeenCalled();
    await expect(
      nativeVoiceMedia(
        null,
        async () => ({ granted: true }),
        () => "id",
      )({} as VoiceMediaOptions),
    ).rejects.toThrow(/Rebuild/);
  });

  it("preempts playback, blocks playback during voice, and is cancelled by dictation", async () => {
    const pause = vi.fn();
    const playback = acquireAudioSession("playback", pause);
    cleanup.push(() => releaseAudioSession(playback));
    const { start, native, options } = setup();
    await start();
    expect(pause).toHaveBeenCalledTimes(1);
    const blocked = acquireAudioSession("playback");
    expect(await activateAudioSession(blocked)).toBe(false);
    const dictation = acquireAudioSession("recording");
    cleanup.push(() => releaseAudioSession(dictation));
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(options.fail).toHaveBeenCalledWith(expect.stringContaining("another recorder"));
    expect(await activateAudioSession(dictation)).toBe(true);
  });

  it("waits for an old native recorder preparation before activating the successor", async () => {
    const prepared = Promise.withResolvers<void>();
    const old = acquireAudioSession("recording");
    cleanup.push(() => releaseAudioSession(old));
    const preparing = prepareOwnedAudioSession(old, () => prepared.promise);
    // Let the pending native preparation enter its serialized operation.
    await Promise.resolve();
    const next = setup();
    const starting = next.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(next.native.open).not.toHaveBeenCalled();
    prepared.resolve();
    await expect(preparing).rejects.toThrow(/during preparation/);
    await starting;
    expect(next.native.open).toHaveBeenCalledTimes(1);
  });
});
