import * as NodeAssert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { VoiceController, type VoiceState } from "./controller.ts";
import type { VoiceMedia, VoiceSocket } from "./media.ts";
class FakeSocket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  private markConnected = () => {};
  connected = {
    promise: new Promise<void>((resolve) => {
      this.markConnected = resolve;
    }),
  };
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    super.addEventListener(...args);
    if (args[0] === "message") this.markConnected();
  }
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
function harness(
  acquire?: (media: VoiceMedia) => Promise<VoiceMedia>,
  continuous = false,
  drain: () => Promise<void> = async () => {},
) {
  const socket = new FakeSocket();
  const track = { enabled: true, stopped: false };
  let capture: (audio: string, samples: number) => void = () => {};
  let fail: (message: string) => void = () => {};
  let mediaClosed = 0,
    silenced = 0,
    played = 0;
  const media: VoiceMedia = {
    mute: (muted) => {
      track.enabled = !muted;
    },
    dispose: () => {
      if (track.stopped) return;
      track.stopped = true;
      mediaClosed++;
    },
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
    drain,
  };
  const states: VoiceState[] = [];
  const controller = new VoiceController(
    {
      continuous,
      media: async (options) => {
        capture = options.capture;
        fail = options.fail;
        return acquire ? acquire(media) : media;
      },
      socket: () => socket as unknown as VoiceSocket,
      url: async () => "ws://local.invalid/voice?wsTicket=app-ticket",
    },
    (state) => states.push(state),
  );
  return {
    controller,
    track,
    media,
    socket,
    states,
    fail: (message: string) => fail(message),
    capture: (samples = 2400) => capture("AAAAAA==", samples),
    counts: () => ({ mediaClosed, silenced, played }),
  };
}
async function active(h: ReturnType<typeof harness>) {
  const starting = h.controller.start();
  await h.socket.connected.promise;
  h.socket.event({ type: "relay.ready" });
  await starting;
  NodeAssert.equal(h.controller.state.phase, "active");
}

test("push-to-talk appends only recorded audio; finish creates only an audio response", async () => {
  const h = harness();
  await active(h);
  h.capture();
  NodeAssert.equal(h.socket.sent.length, 0);
  await h.controller.record();
  h.capture();
  await h.controller.finish();
  NodeAssert.deepEqual(
    h.socket.sent.map((e) => e.type),
    [
      "input_audio_buffer.clear",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
      "response.create",
    ],
  );
  const response = h.socket.sent.at(-1)!.response as { output_modalities: string[] };
  NodeAssert.deepEqual(response.output_modalities, ["audio"]);
  NodeAssert.equal(h.controller.state.recording, false);
  await h.controller.stop();
  NodeAssert.equal(h.track.stopped, true);
  NodeAssert.equal(h.counts().mediaClosed, 1);
  NodeAssert.equal(h.controller.state.phase, "idle");
  NodeAssert.equal(h.controller.state.error, "");
});

test("mute discards a recording, stops upload and disables hardware tracks", async () => {
  const h = harness();
  await active(h);
  await h.controller.record();
  h.capture();
  await h.controller.mute();
  const sent = h.socket.sent.length;
  h.capture();
  NodeAssert.equal(h.track.enabled, false);
  NodeAssert.equal(h.controller.state.recording, false);
  NodeAssert.equal(h.socket.sent.at(-1)?.type, "input_audio_buffer.clear");
  NodeAssert.equal(h.socket.sent.length, sent);
  NodeAssert.equal(
    h.socket.sent.some((e) => e.type === "response.create"),
    false,
  );
  await h.controller.mute();
  NodeAssert.equal(h.track.enabled, true);
  await h.controller.stop();
});

test("late media grants after Stop are disposed and never open a socket", async () => {
  let grant: (media: VoiceMedia) => void = () => {};
  const pending = new Promise<VoiceMedia>((resolve) => {
    grant = resolve;
  });
  const h = harness(() => pending);
  const starting = h.controller.start();
  await h.controller.stop();
  grant(h.media);
  await starting;
  await vi.waitFor(() => NodeAssert.equal(h.track.stopped, true));
  NodeAssert.equal(h.counts().mediaClosed, 1);
  NodeAssert.equal(h.socket.sent.length, 0);
  NodeAssert.equal(h.controller.state.phase, "idle");
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
  NodeAssert.equal(h.counts().played, 1);
  const interrupted = h.controller.interrupt();
  NodeAssert.equal(h.socket.sent.at(-1)?.type, "response.cancel");
  h.socket.event({ type: "response.done", response: { id: "resp_1", status: "cancelled" } });
  await interrupted;
  NodeAssert.equal(h.socket.sent.at(-1)?.type, "conversation.item.truncate");
  h.socket.event({
    type: "response.audio.delta",
    response_id: "resp_1",
    item_id: "item_1",
    content_index: 0,
    delta: "AAAAAA==",
  });
  NodeAssert.equal(h.counts().played, 1);
  NodeAssert.equal(
    h.socket.sent.some((e) => String(e.type).includes("coding") || e.type === "message.dispatch"),
    false,
  );
  await h.controller.stop();
});

test.each(["relay.error", "error"])(
  "%s fails closed, releases resources, and rejects stale playback",
  async (type) => {
    const h = harness();
    await active(h);
    h.socket.event({
      type,
      message: "Bearer fictional-secret",
      error: { code: "response_cancel_not_active", message: "fictional-secret" },
    });
    await vi.waitFor(() => NodeAssert.equal(h.controller.state.phase, "error"));
    NodeAssert.equal(h.track.stopped, true);
    NodeAssert.equal(h.socket.readyState, 3);
    NodeAssert.equal(h.counts().mediaClosed, 1);
    NodeAssert.equal(JSON.stringify(h.states).includes("fictional-secret"), false);
    const count = h.counts().played;
    h.socket.event({
      type: "response.output_audio.delta",
      response_id: "old",
      item_id: "old",
      content_index: 0,
      delta: "AAAAAA==",
    });
    NodeAssert.equal(h.counts().played, count);
    await h.controller.stop();
    NodeAssert.equal(h.counts().mediaClosed, 1);
  },
);

test("owner disposal clears socket/media and ignores stale callbacks", async () => {
  const h = harness();
  await active(h);
  const count = h.states.length;
  h.controller.dispose();
  await vi.waitFor(() => NodeAssert.equal(h.counts().mediaClosed, 1));
  h.socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "stale",
  });
  NodeAssert.equal(h.states.length, count);
  NodeAssert.equal(h.socket.readyState, 3);
  NodeAssert.equal(h.track.stopped, true);
  NodeAssert.equal(h.counts().mediaClosed, 1);
});

test("Stop during readiness wait settles startup and releases every resource", async () => {
  const h = harness();
  const starting = h.controller.start();
  await h.socket.connected.promise;
  await h.controller.stop();
  await starting;
  NodeAssert.equal(h.track.stopped, true);
  NodeAssert.equal(h.socket.readyState, 3);
  NodeAssert.equal(h.controller.state.phase, "idle");
});

test("audio focus loss fails closed and releases the microphone", async () => {
  const h = harness();
  await active(h);
  h.fail("Audio focus was lost; start a new voice conversation");
  await vi.waitFor(() => NodeAssert.equal(h.controller.state.phase, "error"));
  NodeAssert.equal(h.track.stopped, true);
});

test("interrupt waits for a delayed response identity, cancels it and rejects its audio", async () => {
  const h = harness();
  await active(h);
  await h.controller.record();
  h.capture();
  await h.controller.finish();
  const response = h.socket.sent.at(-1)!.response as { metadata: object };
  const interrupting = h.controller.interrupt();
  h.socket.event({
    type: "response.created",
    response: { id: "late", metadata: response.metadata },
  });
  NodeAssert.equal(h.socket.sent.at(-1)?.type, "response.cancel");
  h.socket.event({
    type: "response.audio.delta",
    response_id: "late",
    item_id: "item",
    content_index: 0,
    delta: "AAAAAA==",
  });
  h.socket.event({ type: "response.done", response: { id: "late", status: "cancelled" } });
  await interrupting;
  NodeAssert.equal(h.counts().played, 0);
  NodeAssert.equal(h.controller.state.phase, "active");
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
  NodeAssert.equal(h.controller.state.transcript, "first");
  await h.controller.record();
  h.socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input_1",
    transcript: "stale",
  });
  NodeAssert.equal(h.controller.state.transcript, "");
  h.capture();
  await h.controller.finish();
  h.socket.event({ type: "input_audio_buffer.committed", item_id: "input_2" });
  h.socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input_2",
    transcript: "second",
  });
  NodeAssert.equal(h.controller.state.transcript, "second");
  await h.controller.stop();
});

test("continuous Start captures automatically without manual commit; Mute/Unmute resumes VAD capture", async () => {
  const h = harness(undefined, true);
  await active(h);
  NodeAssert.equal(h.controller.state.recording, true);
  h.capture(24_000 * 30);
  NodeAssert.equal(h.socket.sent.at(-1)?.type, "input_audio_buffer.append");
  NodeAssert.equal(
    h.socket.sent.some((event) =>
      ["response.create", "input_audio_buffer.commit"].includes(String(event.type)),
    ),
    false,
  );
  await h.controller.mute();
  const mutedCount = h.socket.sent.length;
  h.capture();
  NodeAssert.equal(h.socket.sent.length, mutedCount);
  NodeAssert.equal(h.track.enabled, false);
  await h.controller.mute();
  NodeAssert.equal(h.controller.state.recording, true);
  h.capture();
  NodeAssert.equal(h.socket.sent.at(-1)?.type, "input_audio_buffer.append");
  await h.controller.stop();
});

test("continuous VAD barge-in flushes immediately, truncates played position and ignores old audio while capture stays live", async () => {
  const h = harness(undefined, true);
  await active(h);
  h.socket.event({ type: "relay.response", voice_turn: "vad_turn_1" });
  h.socket.event({
    type: "response.created",
    response: { id: "resp_1", metadata: { voice_turn: "vad_turn_1" } },
  });
  h.socket.event({
    type: "response.audio.delta",
    response_id: "resp_1",
    item_id: "item_1",
    content_index: 0,
    delta: "AAAAAA==",
  });
  await vi.waitFor(() => NodeAssert.equal(h.counts().played, 1));
  const before = h.counts().silenced;
  h.socket.event({ type: "input_audio_buffer.speech_started", item_id: "vad_turn_2" });
  NodeAssert.equal(h.counts().silenced, before + 1);
  NodeAssert.equal(h.socket.sent.at(-1)?.type, "response.cancel");
  h.capture();
  NodeAssert.equal(h.socket.sent.at(-1)?.type, "input_audio_buffer.append");
  h.socket.event({ type: "response.done", response: { id: "resp_1", status: "cancelled" } });
  h.socket.event({
    type: "response.audio.delta",
    response_id: "resp_1",
    item_id: "item_1",
    content_index: 0,
    delta: "AAAAAA==",
  });
  h.socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "vad_turn_2",
    transcript: "Next request",
  });
  await vi.waitFor(() => NodeAssert.equal(h.controller.state.transcript, "Next request"));
  NodeAssert.equal(h.counts().played, 1);
  NodeAssert.equal(h.controller.state.recording, true);
  const truncate = h.socket.sent.find((event) => event.type === "conversation.item.truncate");
  NodeAssert.equal(truncate?.audio_end_ms, 45);
  NodeAssert.equal(
    h.socket.sent.some((event) =>
      ["message.dispatch", "run.interrupt", "response.create"].includes(String(event.type)),
    ),
    false,
  );
  h.socket.event({ type: "agent.status", status: "waiting_for_user_in_T3" });
  await vi.waitFor(() =>
    NodeAssert.equal(h.controller.state.agentStatus, "waiting_for_user_in_T3"),
  );
  await h.controller.stop();
  const states = h.states.length;
  h.socket.event({ type: "agent.bound", thread_id: "late_thread" });
  NodeAssert.equal(h.states.length, states);
});

test("continuous playback ACK waits for actual media drain, not generation done", async () => {
  let resolveDrain: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  const h = harness(undefined, true, () => drained);
  await active(h);
  h.socket.event({ type: "relay.response", voice_turn: "turn_long" });
  h.socket.event({
    type: "response.created",
    response: { id: "resp_1", metadata: { voice_turn: "turn_long" } },
  });
  h.socket.event({
    type: "response.audio.delta",
    response_id: "resp_1",
    item_id: "item_1",
    content_index: 0,
    delta: "AAAAAA==",
  });
  h.socket.event({ type: "response.done", response: { id: "resp_1", status: "completed" } });
  await vi.waitFor(() => NodeAssert.equal(h.counts().played, 1));
  NodeAssert.equal(
    h.socket.sent.some((event) => event.type === "relay.playback.done"),
    false,
  );
  resolveDrain();
  await vi.waitFor(() =>
    NodeAssert.deepEqual(h.socket.sent.at(-1), {
      type: "relay.playback.done",
      response_id: "resp_1",
    }),
  );
  await h.controller.stop();
});

test("expected drain rejection after VAD flush is normal cancellation, not session failure", async () => {
  let rejectDrain: (error: Error) => void = () => {};
  let beganDrain = false;
  const drained = new Promise<void>((_resolve, reject) => {
    rejectDrain = reject;
  });
  const h = harness(undefined, true, () => {
    beganDrain = true;
    return drained;
  });
  await active(h);
  h.socket.event({ type: "relay.response", voice_turn: "turn_draining" });
  h.socket.event({
    type: "response.created",
    response: { id: "resp_1", metadata: { voice_turn: "turn_draining" } },
  });
  h.socket.event({
    type: "response.audio.delta",
    response_id: "resp_1",
    item_id: "item_1",
    content_index: 0,
    delta: "AAAAAA==",
  });
  h.socket.event({ type: "response.done", response: { id: "resp_1", status: "completed" } });
  await vi.waitFor(() => NodeAssert.equal(beganDrain, true));
  h.socket.event({ type: "input_audio_buffer.speech_started", item_id: "next_utterance" });
  rejectDrain(Error("Playback epoch flushed"));
  await vi.waitFor(() => NodeAssert.equal(h.socket.sent.at(-1)?.type, "relay.playback.done"));
  NodeAssert.equal(h.controller.state.phase, "active");
  NodeAssert.equal(h.controller.state.error, "");
  NodeAssert.equal(h.controller.state.recording, true);
  await h.controller.stop();
});
