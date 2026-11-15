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
    case "relay.playback.done":
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
export function sessionUpdate(voice: string, transcriptionModel: string, continuous = false) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      tools: continuous
        ? [
            {
              type: "function",
              name: "run_t3_agent",
              description:
                "Delegate the current finalized user utterance to the bound T3 coding agent, verbatim. Use for work, questions about the task, files, context or progress. No arguments: T3 owns the transcript and target. Never use for permission approval.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          ]
        : [],
      tool_choice: continuous ? "auto" : "none",
      instructions: continuous
        ? "You are the user's conversational coding assistant. Speak in first person (I), not about 'the agent', 'the thread', delegation or internal routing. The voice and coding runtimes may use different models; never claim they are one model. For every task, contextual question, progress question, or change of direction call run_t3_agent once. T3 submits the finalized transcript verbatim. Tool routing is silent: do not acknowledge a task before calling the tool. Do not invent tool results, actions, progress, code changes or completion; claim an action only with actual T3 evidence. Queued/accepted is not evidence of execution or success. Routine status context is silent, including starting, running, idle waiting and completed. When actualAgentResult arrives, give the useful answer once, concisely, without a separate 'done' announcement, generic acknowledgement, or status recap. Preserve meaningful clarifications and errors. Answer user-requested progress from actual evidence, distinguishing this turn from still-running background work. Pending permissions and questions need one concise direction to the normal T3 UI; never approve or treat spoken yes as permission. Interruptions stop speech only; coding continues. If replyToUtterance is provided, answer that conversational utterance briefly without tools. Do not read secrets or raw tool output aloud."
        : "You are a separate voice conversation, not the coding runtime. Reply briefly. You have no tools or code context. Never claim to run code or change files. The user must review and confirm any request sent to their coding thread.",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          turn_detection: continuous
            ? {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 600,
                create_response: false,
                interrupt_response: false,
              }
            : null,
          // Keep the configured model. whisper-1 can be final-only; delta support here
          // is not a promise of word streaming from every upstream/model.
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
  if (
    (e.type === "input_audio_buffer.speech_started" ||
      e.type === "input_audio_buffer.speech_stopped") &&
    id(e.item_id)
  )
    return { type: e.type, item_id: e.item_id };
  if (e.type === "input_audio_buffer.committed" && id(e.item_id)) {
    if (e.previous_item_id != null && !id(e.previous_item_id))
      throw Error("Invalid input predecessor");
    return {
      type: e.type,
      item_id: e.item_id,
      ...(id(e.previous_item_id) ? { previous_item_id: e.previous_item_id } : {}),
    };
  }
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
      Number(e.content_index) < 0 ||
      Number(e.content_index) >= 16 ||
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
    if (
      !id(e.response_id) ||
      !id(e.item_id) ||
      !Number.isInteger(e.content_index) ||
      Number(e.content_index) < 0 ||
      Number(e.content_index) >= 16
    )
      throw Error("Invalid audio identity");
    return {
      type: e.type,
      response_id: e.response_id,
      item_id: e.item_id,
      content_index: e.content_index,
      part: { type: "audio" },
    };
  }
  const inputTranscript = String(e.type).startsWith("conversation.item.input_audio_transcription.");
  if (
    [
      "conversation.item.input_audio_transcription.delta",
      "response.output_audio_transcript.delta",
      "response.audio_transcript.delta",
      "conversation.item.input_audio_transcription.completed",
      "response.output_audio_transcript.done",
      "response.audio_transcript.done",
    ].includes(String(e.type))
  ) {
    if (
      !id(e.item_id) ||
      (!inputTranscript &&
        (!id(e.response_id) ||
          !Number.isInteger(e.content_index) ||
          Number(e.content_index) < 0 ||
          Number(e.content_index) >= 16))
    )
      throw Error("Invalid transcript identity");
    const delta = String(e.type).endsWith(".delta");
    const text = delta ? e.delta : e.transcript;
    if (typeof text !== "string" || text.length > 16000) throw Error("Invalid voice transcript");
    return {
      type: e.type,
      item_id: e.item_id,
      ...(!inputTranscript ? { response_id: e.response_id, content_index: e.content_index } : {}),
      ...(delta ? { delta: text } : { transcript: text }),
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
  private continuous: boolean;
  constructor(continuous = false) {
    this.continuous = continuous;
  }
  committed() {
    this.samples = 0;
  }
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
      if (this.totalSamples > (this.continuous ? 24_000 * 60 * 10 : MAX_TURN_SAMPLES * 32))
        throw Error("Voice conversation audio limit reached");
      if (!this.continuous && this.samples > MAX_TURN_SAMPLES)
        throw Error("Voice turn limit reached");
    }
    if (e.type === "input_audio_buffer.commit" && this.samples < 2400)
      throw Error("Voice turn too short");
    if (e.type === "input_audio_buffer.commit" || e.type === "input_audio_buffer.clear")
      this.samples = 0;
    if (e.type === "response.create" && ++this.turns > 32)
      throw Error("Voice conversation limit reached");
  }
}
