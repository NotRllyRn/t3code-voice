/* eslint-disable unicorn/require-post-message-target-origin -- AudioWorklet MessagePort, not Window.postMessage. */
import { Resampler, MAX_PLAYBACK } from "./pcm.js";

class VoicePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(MAX_PLAYBACK);
    this.read = 0;
    this.write = 0;
    this.length = 0;
    this.phase = 0;
    this.played = 0;
    this.epoch = 0;
    this.ticks = 0;
    this.capture = false;
    this.packet = [];
    this.resampler = new Resampler(sampleRate, 24000);
    this.frames = 0;
    this.lease = 0;
    this.captureFault = false;
    this.outstanding = new Set();
    this.serial = 0;
    this.progressPending = null;
    this.progressSerial = 0;
    this.lastProgress = -1;
    this.port.onmessage = ({ data: d }) => {
      if (d.type === "capture") {
        if (d.enabled && !this.captureFault) {
          this.capture = true;
          this.lease = this.frames + sampleRate * 0.25;
        } else this.capture = false;
        this.packet = [];
        this.resampler = new Resampler(sampleRate, 24000);
      }
      if (d.type === "captureAck" && this.outstanding.delete(d.id) && !this.captureFault)
        this.lease = this.frames + sampleRate * 0.25;
      if (d.type === "progressAck" && d.id === this.progressPending) this.progressPending = null;
      if (d.type === "endCapture") {
        this.capture = false;
        if (this.packet.length && !this.captureFault)
          this.postCapture(new Float32Array(this.packet));
        this.packet = [];
        this.port.postMessage({ type: "captureEnded" });
      }
      if (d.type === "flush") {
        const played = this.played;
        this.read = this.write = this.length = this.phase = this.played = 0;
        this.epoch = d.epoch;
        this.port.postMessage({ type: "flushed", id: d.id, played, epoch: this.epoch });
      }
      if (d.type === "audio" && d.epoch === this.epoch) {
        if (this.length + d.samples.length > MAX_PLAYBACK) {
          this.port.postMessage({ type: "overflow" });
          return;
        }
        for (const v of d.samples) {
          this.ring[this.write] = v;
          this.write = (this.write + 1) % MAX_PLAYBACK;
          this.length++;
        }
      }
    };
  }
  captureFailed() {
    if (this.captureFault) return;
    this.captureFault = true;
    this.capture = false;
    this.packet = [];
    this.port.postMessage({ type: "captureFailed" }); // Sticky: late acknowledgments cannot restart it.
  }
  postCapture(samples) {
    if (this.outstanding.size >= 3) {
      this.captureFailed();
      return;
    }
    const id = ++this.serial;
    this.outstanding.add(id);
    this.port.postMessage({ type: "capture", id, at: currentTime, samples }, [samples.buffer]);
  }
  process(inputs, outputs) {
    this.frames += outputs[0]?.[0]?.length || 128;
    if (this.capture && this.frames >= this.lease) this.captureFailed();
    const input = inputs[0]?.[0];
    if (this.capture && input) {
      this.packet.push(...this.resampler.push(input));
      while (this.capture && this.packet.length >= 960)
        this.postCapture(new Float32Array(this.packet.splice(0, 960)));
    }
    const output = outputs[0]?.[0];
    if (output)
      for (let i = 0; i < output.length; i++) {
        output[i] = this.length
          ? this.ring[this.read] * (1 - this.phase) +
            this.ring[this.length > 1 ? (this.read + 1) % MAX_PLAYBACK : this.read] * this.phase
          : 0;
        if (this.length) {
          this.phase += 24000 / sampleRate;
          while (this.phase >= 1 && this.length) {
            this.phase--;
            this.read = (this.read + 1) % MAX_PLAYBACK;
            this.length--;
            this.played++;
          }
          if (!this.length) this.phase = 0;
        }
      }
    if (
      ++this.ticks % 8 === 0 &&
      this.progressPending === null &&
      this.played !== this.lastProgress
    ) {
      this.progressPending = ++this.progressSerial;
      this.lastProgress = this.played;
      this.port.postMessage({
        type: "progress",
        id: this.progressPending,
        played: this.played,
        epoch: this.epoch,
      });
    }
    return true;
  }
}
registerProcessor("voice-pcm", VoicePCM);
