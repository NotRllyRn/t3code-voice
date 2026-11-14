export const PCM_RATE = 24000;
export const MAX_PLAYBACK = PCM_RATE * 8;
export const MIN_INPUT_SAMPLES = 2400;
// Continuous linear resampler; retains phase and a boundary sample across render quanta.
export class Resampler {
  constructor(from, to) {
    this.step = from / to;
    this.position = 0;
    this.tail = [];
  }
  push(input) {
    const values = this.tail.concat(Array.from(input));
    const out = [];
    while (this.position + 1 < values.length) {
      const i = Math.floor(this.position),
        f = this.position - i;
      out.push(values[i] * (1 - f) + values[i + 1] * f);
      this.position += this.step;
    }
    const used = Math.min(Math.floor(this.position), values.length);
    this.tail = values.slice(used);
    this.position -= used;
    return out;
  }
}
export function decodePCM(base64) {
  if (base64.length > 131072) throw Error("Audio chunk limit");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (bytes.length % 2) throw Error("Invalid PCM");
  const v = new DataView(bytes.buffer),
    result = new Float32Array(bytes.length / 2);
  for (let i = 0; i < result.length; i++) result[i] = v.getInt16(i * 2, true) / 32768;
  return result;
}
export function encodePCM(samples) {
  const bytes = new Uint8Array(samples.length * 2),
    v = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++)
    v.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), true);
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}
export function playedItem(timeline, consumed, latencySamples = 0) {
  const heard = Math.max(0, consumed - latencySamples);
  let offset = 0,
    current = null;
  for (const chunk of timeline) {
    if (heard < offset + chunk.samples) {
      current = chunk;
      break;
    }
    current = chunk;
    offset += chunk.samples;
  }
  if (!current) return null;
  let start = 0;
  for (const chunk of timeline) {
    if (chunk.itemId === current.itemId && chunk.contentIndex === current.contentIndex) break;
    start += chunk.samples;
  }
  const total = timeline
    .filter((c) => c.itemId === current.itemId && c.contentIndex === current.contentIndex)
    .reduce((n, c) => n + c.samples, 0);
  return {
    itemId: current.itemId,
    contentIndex: current.contentIndex,
    ms: Math.floor(Math.min(total, Math.max(0, heard - start)) / 24),
  };
}
