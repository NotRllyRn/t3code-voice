import * as NodeAssert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { Lifecycle, type VoiceMediaOptions } from "@t3tools/client-runtime/voice-conversation";
import { browserMedia } from "./media.js";

function setup() {
  const track = Object.assign(new EventTarget(), { enabled: true, stop: vi.fn() });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const contexts: Context[] = [];
  const disconnect = vi.fn();
  const portClose = vi.fn();
  class Context extends EventTarget {
    state = "running";
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => {}) };
    close = vi.fn(async () => {
      this.state = "closed";
      this.dispatchEvent(new Event("statechange"));
    });
    constructor() {
      super();
      contexts.push(this);
    }
    async resume() {}
    createGain() {
      return {
        gain: { value: 0, setValueAtTime() {}, cancelScheduledValues() {} },
        connect() {},
        disconnect,
      };
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect };
    }
  }
  class Worklet {
    port = { onmessage: null, postMessage() {}, close: portClose };
    connect() {}
    disconnect = disconnect;
  }
  const permission = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: permission } });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  const life = new Lifecycle();
  const session = life.begin("voice", "ws");
  const failed = vi.fn();
  const options: VoiceMediaOptions = {
    own: (finalizer) => life.own(session, finalizer),
    alive: () => life.alive(session),
    fail: (message) => {
      failed(message);
      void life.stop(message);
    },
    capture() {},
  };
  return {
    track,
    stream,
    contexts,
    permission,
    life,
    options,
    failed,
    disconnect,
    portClose,
    async [Symbol.asyncDispose]() {
      await life.stop();
      vi.unstubAllGlobals();
    },
  };
}

test("late permission grants release tracks without creating an audio context", async () => {
  await using h = setup();
  let grant: (stream: MediaStream) => void = () => {};
  h.permission.mockImplementationOnce(() => new Promise((resolve) => (grant = resolve)));
  const starting = browserMedia(h.options);
  await h.life.stop();
  grant(h.stream);
  await NodeAssert.rejects(starting, /Stopped/);
  await vi.waitFor(() => NodeAssert.equal(h.track.stop.mock.calls.length, 1));
  NodeAssert.equal(h.contexts.length, 0);
});

test("worklet startup failure releases the microphone and partially acquired context", async () => {
  await using h = setup();
  using _missingWorklet = vi.spyOn(globalThis, "AudioWorkletNode").mockImplementation(() => {
    throw Error("worklet unavailable");
  });
  await NodeAssert.rejects(browserMedia(h.options), /worklet unavailable/);
  await h.life.stop();
  NodeAssert.equal(h.track.stop.mock.calls.length, 1);
  NodeAssert.equal(h.contexts[0]!.close.mock.calls.length, 1);
});

test.each(["track", "context"])(
  "%s loss stops owned media; mute and repeated cleanup leave no listeners or ports",
  async (source) => {
    await using h = setup();
    const media = await browserMedia(h.options);
    media.mute(true);
    NodeAssert.equal(h.track.enabled, false);
    media.mute(false);
    NodeAssert.equal(h.track.enabled, true);
    const context = h.contexts[0]!;
    const lose = () => {
      if (source === "track") h.track.dispatchEvent(new Event("ended"));
      else {
        context.state = "suspended";
        context.dispatchEvent(new Event("statechange"));
      }
    };
    lose();
    await h.life.stop();
    await media.dispose();
    await media.dispose();
    NodeAssert.equal(h.track.stop.mock.calls.length, 1);
    NodeAssert.equal(context.close.mock.calls.length, 1);
    NodeAssert.equal(h.portClose.mock.calls.length, 1);
    NodeAssert.equal(h.disconnect.mock.calls.length, 3);
    const failures = h.failed.mock.calls.length;
    lose();
    NodeAssert.equal(h.failed.mock.calls.length, failures);
  },
);
