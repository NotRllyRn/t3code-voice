import assert from "node:assert/strict";
import { test } from "node:test";
import { VoiceController, type VoiceDependencies, type VoiceState } from "./controller.ts";
import type { VoiceMedia } from "./media.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
class Track extends EventTarget {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class FakeSocket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  event(data: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}
function harness(microphone?: VoiceDependencies["microphone"]) {
  const track = new Track(),
    socket = new FakeSocket();
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  let capture: (audio: string, samples: number) => void = () => {};
  let mediaClosed = 0,
    silenced = 0,
    played = 0;
  const audio = Object.assign(new EventTarget(), { state: "running" });
  const media = {
    context: audio,
    capture: () => {},
    finishCapture: async () => {},
    allow: () => {},
    silence: async () => {
      silenced++;
      return { itemId: "item_1", contentIndex: 0, ms: 45 };
    },
    enqueue: () => {
      played++;
    },
  } as unknown as VoiceMedia;
  const states: VoiceState[] = [];
  const controller = new VoiceController(
    {
      microphone: microphone ?? (async () => stream),
      media: async (_stream, options) => {
        capture = options.capture;
        options.own(() => {
          mediaClosed++;
        });
        return media;
      },
      socket: () => socket as unknown as WebSocket,
      url: async () => "ws://local.invalid/voice?wsTicket=app-ticket",
    },
    (state) => states.push(state),
  );
  return {
    controller,
    track,
    stream,
    socket,
    states,
    audio,
    capture: (samples = 2400) => capture("AAAAAA==", samples),
    counts: () => ({ mediaClosed, silenced, played }),
  };
}
async function active(h: ReturnType<typeof harness>) {
  const starting = h.controller.start();
  await tick();
  h.socket.event({ type: "relay.ready" });
  await starting;
  assert.equal(h.controller.state.phase, "active");
}

test("push-to-talk appends only recorded audio; finish creates only an audio response", async () => {
  const h = harness();
  await active(h);
  h.capture();
  assert.equal(h.socket.sent.length, 0);
  await h.controller.record();
  h.capture();
  await h.controller.finish();
  assert.deepEqual(
    h.socket.sent.map((e) => e.type),
    [
      "input_audio_buffer.clear",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
      "response.create",
    ],
  );
  const response = h.socket.sent.at(-1)!.response as { output_modalities: string[] };
  assert.deepEqual(response.output_modalities, ["audio"]);
  assert.equal(h.controller.state.recording, false);
  await h.controller.stop();
  assert.equal(h.track.stopped, true);
  assert.equal(h.counts().mediaClosed, 1);
});

test("mute discards a recording, stops upload and disables hardware tracks", async () => {
  const h = harness();
  await active(h);
  await h.controller.record();
  h.capture();
  await h.controller.mute();
  const sent = h.socket.sent.length;
  h.capture();
  assert.equal(h.track.enabled, false);
  assert.equal(h.controller.state.recording, false);
  assert.equal(h.socket.sent.at(-1)?.type, "input_audio_buffer.clear");
  assert.equal(h.socket.sent.length, sent);
  assert.equal(
    h.socket.sent.some((e) => e.type === "response.create"),
    false,
  );
  await h.controller.mute();
  assert.equal(h.track.enabled, true);
  await h.controller.stop();
});

test("late microphone grants after Stop release tracks and never start media", async () => {
  let grant: (stream: MediaStream) => void = () => {};
  const pending = new Promise<MediaStream>((resolve) => {
    grant = resolve;
  });
  const h = harness(() => pending);
  const starting = h.controller.start();
  await h.controller.stop();
  grant(h.stream);
  await starting;
  await tick();
  assert.equal(h.track.stopped, true);
  assert.equal(h.counts().mediaClosed, 0);
  assert.equal(h.controller.state.phase, "idle");
});

test("voice interruption silences first, cancels only voice, truncates played audio and drops late deltas", async () => {
  const h = harness();
  await active(h);
  await h.controller.record();
  h.capture();
  await h.controller.finish();
  const response = h.socket.sent.at(-1)!.response as { metadata: object };
  h.socket.event({
    type: "response.created",
    response: { id: "resp_1", metadata: response.metadata },
  });
  h.socket.event({
    type: "response.audio.delta",
    response_id: "resp_1",
    item_id: "item_1",
    content_index: 0,
    delta: "AAAAAA==",
  });
  assert.equal(h.counts().played, 1);
  const interrupted = h.controller.interrupt();
  assert.equal(h.socket.sent.at(-1)?.type, "response.cancel");
  h.socket.event({ type: "response.done", response: { id: "resp_1", status: "cancelled" } });
  await interrupted;
  assert.equal(h.socket.sent.at(-1)?.type, "conversation.item.truncate");
  h.socket.event({
    type: "response.audio.delta",
    response_id: "resp_1",
    item_id: "item_1",
    content_index: 0,
    delta: "AAAAAA==",
  });
  assert.equal(h.counts().played, 1);
  assert.equal(
    h.socket.sent.some((e) => String(e.type).includes("coding") || e.type === "message.dispatch"),
    false,
  );
  await h.controller.stop();
});

test("owner disposal clears socket/media and ignores stale callbacks", async () => {
  const h = harness();
  await active(h);
  const count = h.states.length;
  h.controller.dispose();
  await tick();
  h.socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "stale",
  });
  assert.equal(h.states.length, count);
  assert.equal(h.socket.readyState, 3);
  assert.equal(h.track.stopped, true);
  assert.equal(h.counts().mediaClosed, 1);
});

test("Stop during readiness wait settles startup and releases every resource", async () => {
  const h = harness();
  const starting = h.controller.start();
  await tick();
  await h.controller.stop();
  await starting;
  assert.equal(h.track.stopped, true);
  assert.equal(h.socket.readyState, 3);
  assert.equal(h.controller.state.phase, "idle");
});

test("audio focus loss fails closed and releases the microphone", async () => {
  const h = harness();
  await active(h);
  h.audio.state = "suspended";
  h.audio.dispatchEvent(new Event("statechange"));
  await tick();
  assert.equal(h.controller.state.phase, "error");
  assert.equal(h.track.stopped, true);
});

test("interrupt waits for a delayed response identity, cancels it and rejects its audio", async () => {
  const h = harness();
  await active(h);
  await h.controller.record();
  h.capture();
  await h.controller.finish();
  const response = h.socket.sent.at(-1)!.response as { metadata: object };
  const interrupting = h.controller.interrupt();
  await tick();
  h.socket.event({
    type: "response.created",
    response: { id: "late", metadata: response.metadata },
  });
  assert.equal(h.socket.sent.at(-1)?.type, "response.cancel");
  h.socket.event({
    type: "response.audio.delta",
    response_id: "late",
    item_id: "item",
    content_index: 0,
    delta: "AAAAAA==",
  });
  h.socket.event({ type: "response.done", response: { id: "late", status: "cancelled" } });
  await interrupting;
  assert.equal(h.counts().played, 0);
  assert.equal(h.controller.state.phase, "active");
  await h.controller.stop();
});

test("late transcription from an old input turn cannot replace the reviewed current transcript", async () => {
  const h = harness();
  await active(h);
  await h.controller.record();
  h.capture();
  await h.controller.finish();
  const response = h.socket.sent.at(-1)!.response as { metadata: object };
  h.socket.event({ type: "input_audio_buffer.committed", item_id: "input_1" });
  h.socket.event({
    type: "response.created",
    response: { id: "first", metadata: response.metadata },
  });
  h.socket.event({ type: "response.done", response: { id: "first", status: "completed" } });
  h.socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input_1",
    transcript: "first",
  });
  assert.equal(h.controller.state.transcript, "first");
  await h.controller.record();
  h.socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input_1",
    transcript: "stale",
  });
  assert.equal(h.controller.state.transcript, "");
  h.capture();
  await h.controller.finish();
  h.socket.event({ type: "input_audio_buffer.committed", item_id: "input_2" });
  h.socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input_2",
    transcript: "second",
  });
  assert.equal(h.controller.state.transcript, "second");
  await h.controller.stop();
});
