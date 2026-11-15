import * as NodeAssert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import {
  Conversation,
  Lifecycle,
  type VoiceMediaOptions,
  type RealtimeEvent,
} from "@t3tools/client-runtime/voice-conversation";
import { browserMedia } from "./media.js";
import workletSource from "./pcm-worklet.js?raw";
import * as NodeVM from "node:vm";
import { Resampler, MAX_PLAYBACK } from "./pcm.js";

type Packet = {
  type: string;
  id?: number;
  epoch?: number;
  played?: number;
  samples?: Float32Array;
};
type Port = { onmessage: ((event: { data: Packet }) => void) | null };
type Processor = {
  port: Port;
  length: number;
  played: number;
  epoch: number;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): void;
};

function setup(rate = 24000) {
  const track = Object.assign(new EventTarget(), { enabled: true, stop: vi.fn() });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const contexts: Context[] = [];
  const disconnect = vi.fn();
  const portClose = vi.fn();
  let outer: Port;
  let processor: Processor;
  let ProcessorClass: new () => Processor;
  let delayProgress = false;
  let failTransfer = false;
  let audioTransfers = 0;
  const delayed: Packet[] = [];
  class WorkletProcessor {
    port = {
      onmessage: null,
      postMessage(data: Packet) {
        if (delayProgress && data.type === "progress") delayed.push(data);
        else outer.onmessage?.({ data });
      },
    };
  }
  NodeVM.runInNewContext(workletSource.replace(/^import .*;$/m, ""), {
    AudioWorkletProcessor: WorkletProcessor,
    Resampler,
    MAX_PLAYBACK,
    Float32Array,
    sampleRate: rate,
    currentTime: 0,
    registerProcessor(_name: string, ctor: new () => Processor) {
      ProcessorClass = ctor;
    },
  });
  class Context extends EventTarget {
    state = "running";
    currentTime = 0;
    baseLatency = 0;
    outputLatency = 0;
    gain = 0;
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
        gain: {
          value: 0,
          setValueAtTime: (value: number) => {
            this.gain = value;
          },
          cancelScheduledValues() {},
        },
        connect() {},
        disconnect,
      };
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect };
    }
  }
  class Worklet {
    port = {
      onmessage: null,
      postMessage(data: Packet, transfer: Transferable[] = []) {
        if (data.type === "audio") {
          if (failTransfer) throw Error("private transfer details");
          audioTransfers++;
        }
        processor.port.onmessage?.({ data: structuredClone(data, { transfer }) });
      },
      close: portClose,
    };
    constructor() {
      outer = this.port;
      processor = new ProcessorClass();
    }
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
    capture: vi.fn(),
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
    processor: () => processor,
    audioTransfers: () => audioTransfers,
    failTransfer() {
      failTransfer = true;
    },
    delayProgress(value: boolean) {
      delayProgress = value;
    },
    deliverProgress() {
      for (const data of delayed.splice(0)) outer.onmessage?.({ data });
    },
    progress(data: Packet) {
      outer.onmessage?.({ data });
    },
    render(frames: number, capture = false) {
      const samples: number[] = [];
      for (let i = 0; i < frames; i += 128) {
        const output = new Float32Array(Math.min(128, frames - i));
        processor.process(capture ? [[new Float32Array(output.length)]] : [], [[output]]);
        samples.push(...output);
        NodeAssert.ok(processor.length <= MAX_PLAYBACK);
      }
      return samples;
    },
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

function audio(samples = 2400, value = 16384, item = "item") {
  const bytes = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(value, i * 2);
  return { item_id: item, content_index: 0, delta: bytes.toString("base64") };
}

test.each(["burst", "4x"])("long %s reply drains every sample in order", async (mode) => {
  await using h = setup();
  const media = await browserMedia(h.options);
  media.allow();
  let output: number[] = [];
  const chunks = mode === "burst" ? 81 : 120;
  for (let i = 0; i < chunks; i++) {
    media.enqueue(audio(2400, i + 1));
    if (mode === "4x") output.push(...h.render(600));
  }
  NodeAssert.equal(h.failed.mock.calls.length, 0);
  output = output.concat(h.render(chunks * 2400 - output.length + 128));
  for (let i = 0; i < chunks * 2400; i++)
    NodeAssert.equal(output[i], (Math.floor(i / 2400) + 1) / 32768);
  NodeAssert.deepEqual(await media.silence(), {
    itemId: "item",
    contentIndex: 0,
    ms: chunks * 100,
  });
});

test("1001 fully played deltas retain cumulative truncation without a metadata limit", async () => {
  await using h = setup();
  const media = await browserMedia(h.options);
  for (let i = 0; i < 1001; i++) {
    media.enqueue(audio());
    h.render(2400);
  }
  NodeAssert.equal(h.failed.mock.calls.length, 0);
  NodeAssert.equal(h.processor().length, 0);
  NodeAssert.deepEqual(await media.silence(), { itemId: "item", contentIndex: 0, ms: 100100 });
});

test.each([24000, 44100, 48000])(
  "%i Hz playback uses consumption credit, including delayed reports",
  async (rate) => {
    await using h = setup(rate);
    const media = await browserMedia(h.options);
    media.allow();
    media.enqueue(audio(36000));
    media.enqueue(audio(37, 8192));
    h.delayProgress(true);
    const output = h.render(rate);
    NodeAssert.equal(h.processor().played, MAX_PLAYBACK);
    NodeAssert.equal(h.processor().length, 0);
    NodeAssert.equal(h.audioTransfers(), 1);
    h.delayProgress(false);
    h.deliverProgress();
    output.push(...h.render(rate * 2));
    const nonzero = output.filter((v) => v !== 0);
    NodeAssert.equal(nonzero.length, Math.ceil((36037 * rate) / 24000));
    NodeAssert.ok(nonzero.slice(0, Math.floor((35999 * rate) / 24000)).every((v) => v === 0.5));
    NodeAssert.equal(h.processor().played, 36037);
    NodeAssert.equal(h.failed.mock.calls.length, 0);
    NodeAssert.deepEqual(await media.silence(), { itemId: "item", contentIndex: 0, ms: 1501 });
  },
);

test.each(["completed", "generating"])(
  "%s long reply interrupts locally, ignores old epochs, then plays a second turn",
  async (state) => {
    await using h = setup();
    const media = await browserMedia(h.options);
    const commands: RealtimeEvent[] = [];
    const conversation = new Conversation(
      (event) => commands.push(event as RealtimeEvent),
      media,
      h.options.fail,
    );
    const start = (id: string) => {
      conversation.createResponse();
      const request = commands.at(-1)!;
      conversation.event({
        type: "response.created",
        response: { id, metadata: request.response!.metadata! },
      });
    };
    start("first");
    for (let i = 0; i < 120; i++)
      conversation.event({ ...audio(), type: "response.output_audio.delta", response_id: "first" });
    h.contexts[0]!.baseLatency = 0.1;
    h.delayProgress(true);
    h.render(9000);
    if (state === "completed")
      conversation.event({ type: "response.done", response: { id: "first", status: "completed" } });
    const interrupting = conversation.interrupt();
    NodeAssert.equal(h.contexts[0]!.gain, 0);
    NodeAssert.equal(h.processor().length, 0);
    if (state === "generating")
      conversation.event({ type: "response.done", response: { id: "first", status: "cancelled" } });
    await interrupting;
    NodeAssert.deepEqual(
      commands.find((c) => c.type === "conversation.item.truncate"),
      {
        type: "conversation.item.truncate",
        item_id: "item",
        content_index: 0,
        audio_end_ms: 275,
      },
    );
    NodeAssert.equal(
      commands.some((c) => c.type === "response.cancel"),
      state === "generating",
    );
    start("second");
    conversation.event({ ...audio(), type: "response.output_audio.delta", response_id: "first" });
    h.processor().port.onmessage?.({
      data: { type: "audio", epoch: 0, samples: new Float32Array(2400) },
    });
    NodeAssert.equal(h.processor().length, 0);
    for (let i = 0; i < 12; i++)
      conversation.event({
        ...audio(2400, 8192, "next"),
        type: "response.output_audio.delta",
        response_id: "second",
      });
    h.delayProgress(false);
    // New progress must work before an old epoch's outstanding ACK is delivered.
    const output = h.render(28800);
    NodeAssert.ok(output.every((v) => v === 0.25));
    const transfers = h.audioTransfers();
    h.deliverProgress();
    NodeAssert.equal(h.audioTransfers(), transfers);
    NodeAssert.equal(h.processor().played, 28800);
    NodeAssert.equal(h.failed.mock.calls.length, 0);
    NodeAssert.deepEqual(await media.silence(), { itemId: "next", contentIndex: 0, ms: 1100 });
    conversation.close();
  },
);

test("120-second finite reply budget is independent of draining; overflow stops rather than dropping speech", async () => {
  await using h = setup();
  const media = await browserMedia(h.options);
  media.allow();
  for (let i = 0; i < 80; i++) media.enqueue(audio(36000));
  NodeAssert.equal(h.failed.mock.calls.length, 0);
  NodeAssert.ok(h.processor().length <= 12000);
  h.render(24000);
  media.enqueue(audio(1));
  NodeAssert.deepEqual(h.failed.mock.calls, [["Voice reply exceeds 120-second playback limit"]]);
  NodeAssert.equal(h.contexts[0]!.gain, 0);
  NodeAssert.equal(h.processor().length, 0);
  media.allow();
  media.enqueue(audio());
  NodeAssert.equal(h.contexts[0]!.gain, 0);
});

test.each([
  ["Invalid PCM base64", "%%%%"],
  ["Invalid PCM byte length", "AA=="],
  ["Audio chunk exceeds size limit", "A".repeat(131073)],
])("malformed PCM produces the safe category %s", async (message, delta) => {
  await using h = setup();
  const media = await browserMedia(h.options);
  media.enqueue({ ...audio(), delta });
  NodeAssert.deepEqual(h.failed.mock.calls, [[message]]);
  NodeAssert.equal(h.processor().length, 0);
});

test.each(["identity", "transfer", "worklet"])(
  "%s failure is distinct and flushes already queued audio",
  async (kind) => {
    await using h = setup();
    const media = await browserMedia(h.options);
    media.allow();
    media.enqueue(audio(36000));
    if (kind === "identity") media.enqueue(audio(1, 8192, "other"));
    if (kind === "transfer") {
      h.failTransfer();
      h.render(128 * 8);
    }
    if (kind === "worklet") h.progress({ type: "overflow", epoch: 0 });
    NodeAssert.deepEqual(h.failed.mock.calls, [
      [
        kind === "identity"
          ? "Unsupported audio output item"
          : kind === "transfer"
            ? "Audio playback transfer failed"
            : "Playback worklet buffer overflow",
      ],
    ]);
    NodeAssert.equal(h.contexts[0]!.gain, 0);
    NodeAssert.equal(h.processor().length, 0);
  },
);

test("capture start/finish and capture across playback silence remain supported", async () => {
  await using h = setup();
  const media = await browserMedia(h.options);
  media.capture(true);
  h.render(24000, true);
  const calls = vi.mocked(h.options.capture).mock.calls.length;
  NodeAssert.ok(calls > 0);
  media.enqueue(audio(36000));
  await media.silence();
  h.render(2400, true);
  NodeAssert.ok(vi.mocked(h.options.capture).mock.calls.length > calls);
  await media.finishCapture();
  const finished = vi.mocked(h.options.capture).mock.calls.length;
  h.render(2400, true);
  NodeAssert.equal(vi.mocked(h.options.capture).mock.calls.length, finished);
  media.capture(true);
  h.render(2400, true);
  NodeAssert.ok(vi.mocked(h.options.capture).mock.calls.length > finished);
  media.capture(false);
});

test("empty deltas retain no timeline; dispose invalidates spool and late pumping even if owner is alive", async () => {
  await using h = setup();
  const media = await browserMedia(h.options);
  for (let i = 0; i < 1001; i++) media.enqueue(audio(0));
  NodeAssert.equal(await media.silence(), null);
  NodeAssert.equal(h.audioTransfers(), 0);
  media.allow();
  media.enqueue(audio(36000));
  h.delayProgress(true);
  h.render(2400);
  const transfers = h.audioTransfers();
  await media.dispose();
  h.deliverProgress();
  media.enqueue(audio());
  media.allow();
  NodeAssert.equal(h.audioTransfers(), transfers);
  NodeAssert.equal(h.contexts[0]!.state, "closed");
  NodeAssert.equal(h.contexts[0]!.gain, 0);
  NodeAssert.equal(h.failed.mock.calls.length, 0);
});
