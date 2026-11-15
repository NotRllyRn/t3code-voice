/* eslint-disable unicorn/require-post-message-target-origin -- AudioWorklet MessagePort, not Window.postMessage. */
import { deadline } from "@t3tools/client-runtime/voice-conversation";
import workletUrl from "./pcm-worklet.js?worker&url";
import {
  MAX_PLAYBACK,
  MAX_REPLY,
  decodePCMBytes,
  pcmSamples,
  encodePCM,
  playedItem,
} from "./pcm.js";

export async function browserMedia(options) {
  const finalizers = [];
  let cleanup;
  let disposing = false;
  const dispose = () => {
    disposing = true;
    return (cleanup ??= Promise.allSettled(finalizers.map(async (finalizer) => finalizer())));
  };
  const own = (finalizer) => {
    if (cleanup)
      void Promise.resolve()
        .then(finalizer)
        .catch(() => {});
    else finalizers.push(finalizer);
  };
  options.own(dispose);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  own(() => stream.getTracks().forEach((track) => track.stop()));
  if (!options.alive()) {
    await dispose();
    throw Error("Stopped");
  }
  for (const track of stream.getTracks()) {
    const ended = () => {
      if (!disposing) options.fail("Microphone disconnected");
    };
    track.addEventListener("ended", ended);
    own(() => track.removeEventListener("ended", ended));
  }
  const media = await pcmMedia(stream, { ...options, own });
  if (!options.alive()) {
    await dispose();
    throw Error("Stopped");
  }
  const audioChanged = () => {
    if (!disposing && media.context.state !== "running")
      options.fail("Audio focus was lost; start a new voice conversation");
  };
  media.context.addEventListener("statechange", audioChanged);
  own(() => media.context.removeEventListener("statechange", audioChanged));
  return {
    ...media,
    mute(muted) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    },
    dispose,
  };
}

export async function pcmMedia(stream, { own, alive, fail, capture }) {
  const context = new AudioContext({ latencyHint: "interactive" });
  own(() => context.close());
  if (!context.audioWorklet) throw Error("AudioWorklet is required");
  await deadline(context.audioWorklet.addModule(workletUrl), 2000);
  if (!alive()) throw Error("Stopped");
  const node = new AudioWorkletNode(context, "voice-pcm", {
    outputChannelCount: [1],
    channelCount: 1,
  });
  const gain = context.createGain();
  gain.gain.value = 0;
  const source = context.createMediaStreamSource(stream);
  own(() => {
    node.port.onmessage = null;
    node.port.close();
    node.disconnect();
  });
  own(() => source.disconnect());
  own(() => gain.disconnect());
  source.connect(node);
  node.connect(gain);
  gain.connect(context.destination);
  await deadline(context.resume(), 2000, "Audio context did not start");
  let epoch = 0,
    sent = 0,
    received = 0,
    played = 0,
    spool = null,
    timeline = [],
    playbackFault = false,
    closed = false,
    flushId = 0,
    capturing = false,
    captureFault = false;
  const captureFailed = () => {
    if (captureFault) return;
    captureFault = true;
    capturing = false;
    node.port.postMessage({ type: "capture", enabled: false });
    fail("Capture stalled or transfer limit exceeded");
  };
  const pending = new Map();
  let endCapture = null;
  const mute = () => {
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setValueAtTime(0, context.currentTime);
  };
  const clearPlayback = () => {
    spool = null;
    timeline = [];
    sent = received = played = 0;
    ++epoch;
  };
  const silence = () => {
    mute();
    const before = timeline;
    clearPlayback();
    if (closed) return Promise.resolve(null);
    const id = ++flushId;
    const flushed = new Promise((resolve) => pending.set(id, resolve));
    try {
      node.port.postMessage({ type: "flush", id, epoch });
    } catch {
      pending.delete(id);
      return Promise.reject(Error("Audio playback flush transfer failed"));
    }
    return deadline(flushed, 180, "Audio worklet did not flush").then((samples) =>
      playedItem(
        before,
        samples || 0,
        Math.ceil(((context.baseLatency || 0) + (context.outputLatency || 0)) * 24000),
      ),
    );
  };
  const playbackFailed = (message) => {
    if (playbackFault || closed) return;
    playbackFault = true;
    // Stop locally even when the owner has not finished shutting down the session.
    void silence().catch(() => {});
    fail(message);
  };
  const pump = () => {
    if (closed || playbackFault || !alive()) return;
    const count = Math.min(received - sent, MAX_PLAYBACK - (sent - played));
    if (count <= 0) return;
    const samples = pcmSamples(spool.subarray(sent * 2, (sent + count) * 2));
    spool.fill(0, sent * 2, (sent + count) * 2);
    sent += count;
    try {
      node.port.postMessage({ type: "audio", samples, epoch }, [samples.buffer]);
    } catch {
      playbackFailed("Audio playback transfer failed");
    }
  };
  own(() => {
    closed = true;
    mute();
    clearPlayback();
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  });
  node.port.onmessage = ({ data: d }) => {
    if (closed || !alive()) return;
    if (d.type === "capture") {
      // Check the audio sample clock before forwarding anything queued during a
      // main-thread stall. ACK only after consumption; never replay stale speech.
      if (!captureFault && context.currentTime - d.at >= 0.1) captureFailed();
      if (capturing && !captureFault) {
        try {
          capture(encodePCM(d.samples), d.samples.length);
        } catch {
          captureFailed();
        }
      }
      node.port.postMessage({ type: "captureAck", id: d.id });
    }
    if (d.type === "captureFailed") captureFailed();
    if (d.type === "captureEnded" && endCapture) {
      capturing = false;
      endCapture();
      endCapture = null;
    }
    if (d.type === "overflow" && d.epoch === epoch)
      playbackFailed("Playback worklet buffer overflow");
    if (d.type === "progress") {
      if (d.epoch === epoch) {
        if (!Number.isInteger(d.played) || d.played < played || d.played > sent)
          playbackFailed("Invalid playback consumption report");
        else {
          played = d.played;
          pump();
        }
      }
      node.port.postMessage({ type: "progressAck", id: d.id });
    }
    if (d.type === "flushed") {
      const resolve = pending.get(d.id);
      if (resolve) {
        pending.delete(d.id);
        resolve(d.played);
      }
    }
  };
  return {
    context,
    capture(enabled) {
      if (enabled && captureFault) throw Error("Capture already failed");
      capturing = enabled;
      node.port.postMessage({ type: "capture", enabled });
    },
    finishCapture() {
      const ended = new Promise((resolve) => {
        endCapture = resolve;
      });
      node.port.postMessage({ type: "endCapture" });
      return deadline(ended, 200, "Capture flush timed out");
    },
    allow() {
      if (!closed && !playbackFault && alive()) gain.gain.setValueAtTime(1, context.currentTime);
    },
    silence,
    enqueue(e) {
      if (closed || playbackFault || !alive()) return;
      if (
        !e.item_id ||
        !Number.isInteger(e.content_index) ||
        e.content_index < 0 ||
        timeline.some((c) => c.itemId !== e.item_id || c.contentIndex !== e.content_index)
      ) {
        playbackFailed("Unsupported audio output item");
        return;
      }
      let bytes;
      try {
        bytes = decodePCMBytes(e.delta);
      } catch (error) {
        playbackFailed(error.message);
        return;
      }
      const count = bytes.length / 2;
      if (received + count > MAX_REPLY) {
        playbackFailed("Voice reply exceeds 120-second playback limit");
        return;
      }
      if (!count) return;
      // Fixed compact storage bounds even a fully burst-delivered reply to 5.76 MB.
      spool ??= new Uint8Array(MAX_REPLY * 2);
      spool.set(bytes, received * 2);
      received += count;
      if (!timeline.length)
        timeline.push({ itemId: e.item_id, contentIndex: e.content_index, samples: 0 });
      timeline[0].samples = received;
      pump();
    },
  };
}
