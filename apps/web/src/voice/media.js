import { deadline } from "./lifecycle.js";
import workletUrl from "./pcm-worklet.js?worker&url";
import { MAX_PLAYBACK, decodePCM, encodePCM, playedItem } from "./pcm.js";

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
    played = 0,
    timeline = [],
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
  own(() => {
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  });
  node.port.onmessage = ({ data: d }) => {
    if (!alive()) return;
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
    if (d.type === "overflow") fail("Playback queue limit");
    if (d.type === "progress") {
      if (d.epoch === epoch) played = d.played;
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
      gain.gain.setValueAtTime(1, context.currentTime);
    },
    silence() {
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setValueAtTime(0, context.currentTime);
      const before = timeline;
      timeline = [];
      sent = played = 0;
      ++epoch;
      const id = ++flushId;
      const flushed = new Promise((resolve) => pending.set(id, resolve));
      node.port.postMessage({ type: "flush", id, epoch });
      return deadline(flushed, 180, "Audio worklet did not flush").then((samples) =>
        playedItem(
          before,
          samples || 0,
          Math.ceil(((context.baseLatency || 0) + (context.outputLatency || 0)) * 24000),
        ),
      );
    },
    enqueue(e) {
      try {
        const samples = decodePCM(e.delta);
        // Keep each response to one bounded assistant audio item.
        if (
          !e.item_id ||
          !Number.isInteger(e.content_index) ||
          timeline.some((c) => c.itemId !== e.item_id || c.contentIndex !== e.content_index)
        )
          throw Error("Multiple output items are unsupported");
        if (sent - played + samples.length > MAX_PLAYBACK || timeline.length >= 1000)
          throw Error("Playback queue limit");
        timeline.push({
          itemId: e.item_id,
          contentIndex: e.content_index,
          samples: samples.length,
        });
        sent += samples.length;
        node.port.postMessage({ type: "audio", samples, epoch }, [samples.buffer]);
      } catch {
        fail("Invalid audio or bounded playback queue exceeded");
      }
    },
  };
}
