/** Narrow OpenAI-compatible Realtime WS policy. No coding or upstream tool commands. */
export const MAX_FRAME_BYTES = 128 * 1024;
export const MAX_TURN_SAMPLES = 24_000 * 15;
export const MAX_SESSION_MS = 10 * 60_000;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{1,128}$/.test(value);
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function clientEvent(value: unknown): Record<string, unknown> {
  const e = object(value);
  const keys = (...allowed: string[]) =>
    Object.keys(e).every((k) => ["type", ...allowed].includes(k));
  let valid = false;
  switch (e.type) {
    case "input_audio_buffer.append":
      valid =
        keys("audio") &&
        typeof e.audio === "string" &&
        e.audio.length > 0 &&
        e.audio.length <= 4096 &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.audio) &&
        Buffer.from(e.audio, "base64").length % 2 === 0;
      break;
    case "input_audio_buffer.clear":
    case "input_audio_buffer.commit":
      valid = keys();
      break;
    case "response.cancel":
      valid = keys("response_id") && id(e.response_id);
      break;
    case "conversation.item.truncate":
      valid =
        keys("item_id", "content_index", "audio_end_ms") &&
        id(e.item_id) &&
        Number.isInteger(e.content_index) &&
        Number(e.content_index) >= 0 &&
        Number(e.content_index) < 16 &&
        Number.isInteger(e.audio_end_ms) &&
        Number(e.audio_end_ms) >= 0 &&
        Number(e.audio_end_ms) <= 120_000;
      break;
    case "response.create": {
      const r = object(e.response),
        m = object(r.metadata);
      valid =
        keys("response") &&
        Object.keys(r).length === 3 &&
        Array.isArray(r.output_modalities) &&
        r.output_modalities.length === 1 &&
        r.output_modalities[0] === "audio" &&
        r.max_output_tokens === 512 &&
        Object.keys(m).length === 1 &&
        id(m.voice_turn);
      break;
    }
  }
  if (!valid) throw Error("Unsupported voice command");
  return e;
}
export function upstreamUrl(value: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "wss:" &&
      !(url.protocol === "ws:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error("Invalid realtime endpoint");
  return url.toString();
}
export function sessionUpdate(voice: string, transcriptionModel: string) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      tools: [],
      tool_choice: "none",
      instructions:
        "You are a separate voice conversation, not the coding runtime. Reply briefly. You have no tools or code context. Never claim to run code or change files. The user must review and confirm any request sent to their coding thread.",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          turn_detection: null,
          ...(transcriptionModel ? { transcription: { model: transcriptionModel } } : {}),
        },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice },
      },
    },
  };
}
/** Rebuild outbound events so raw errors, URLs, headers and tool arguments cannot leak. */
export function serverEvent(value: unknown): Record<string, unknown> | null {
  const e = object(value),
    r = object(e.response),
    part = object(e.part);
  if (e.type === "error") throw Error("Realtime upstream rejected the voice session");
  if (e.type === "session.updated") return { type: "relay.ready" };
  if (e.type === "input_audio_buffer.committed" && id(e.item_id))
    return { type: e.type, item_id: e.item_id };
  if (e.type === "response.created" || e.type === "response.done") {
    if (!id(r.id)) throw Error("Invalid response identity");
    if (r.status === "failed") throw Error("Voice response failed");
    const turn = object(r.metadata).voice_turn;
    return {
      type: e.type,
      response: { id: r.id, status: r.status, metadata: { voice_turn: id(turn) ? turn : "" } },
    };
  }
  if (e.type === "response.audio.delta" || e.type === "response.output_audio.delta") {
    if (
      !id(e.response_id) ||
      !id(e.item_id) ||
      !Number.isInteger(e.content_index) ||
      typeof e.delta !== "string" ||
      e.delta.length > 96_000
    )
      throw Error("Invalid voice audio");
    return {
      type: e.type,
      response_id: e.response_id,
      item_id: e.item_id,
      content_index: e.content_index,
      delta: e.delta,
    };
  }
  if (e.type === "response.content_part.added" && part.type === "audio") {
    return {
      type: e.type,
      response_id: e.response_id,
      item_id: e.item_id,
      content_index: e.content_index,
      part: { type: "audio" },
    };
  }
  if (
    [
      "conversation.item.input_audio_transcription.completed",
      "response.output_audio_transcript.done",
      "response.audio_transcript.done",
    ].includes(String(e.type))
  ) {
    if (typeof e.transcript !== "string" || e.transcript.length > 16_000)
      throw Error("Invalid voice transcript");
    return {
      type: e.type,
      item_id: e.item_id,
      response_id: e.response_id,
      transcript: e.transcript,
    };
  }
  if (e.type === "conversation.item.input_audio_transcription.failed")
    throw Error("Voice transcription failed");
  return null;
}

/** Per-connection budget, independent of whether a browser follows the UI limits. */
export class VoiceBudget {
  private samples = 0;
  private turns = 0;
  private totalSamples = 0;
  private windowStart = -Infinity;
  private frames = 0;
  accept(e: Record<string, unknown>, now = performance.now()) {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.frames = 0;
    }
    if (++this.frames > 100) throw Error("Voice command rate limit reached");
    if (e.type === "input_audio_buffer.append") {
      const samples = Buffer.from(String(e.audio), "base64").length / 2;
      this.samples += samples;
      this.totalSamples += samples;
      if (this.totalSamples > MAX_TURN_SAMPLES * 32)
        throw Error("Voice conversation audio limit reached");
      if (this.samples > MAX_TURN_SAMPLES) throw Error("Voice turn limit reached");
    }
    if (e.type === "input_audio_buffer.commit" && this.samples < 2400)
      throw Error("Voice turn too short");
    if (e.type === "input_audio_buffer.commit" || e.type === "input_audio_buffer.clear")
      this.samples = 0;
    if (e.type === "response.create" && ++this.turns > 32)
      throw Error("Voice conversation limit reached");
  }
}
