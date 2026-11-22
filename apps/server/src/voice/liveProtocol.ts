import {
  LIVE_VOICE_MAX_SDP_BYTES,
  LIVE_VOICE_REQUESTED_MODEL,
  LiveVoiceSdp,
  type LiveVoiceReason,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const NATIVE_LIVE_MAX_FRAME_BYTES = 128 * 1024;
export const NATIVE_LIVE_APPEND_CHUNK_BYTES = 500;
export const NATIVE_LIVE_MAX_CONTEXT_BYTES = 32 * 1024;
export const NATIVE_LIVE_MAX_NARRATION_BYTES = 8 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const decodeSdp = Schema.decodeUnknownSync(LiveVoiceSdp);
const invalid = () => new Error("Incompatible Live protocol");

export type NativeLiveEvent =
  | { readonly type: "started" | "updated"; readonly sessionId: string }
  | {
      readonly type: "transcript";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly itemId?: string;
    }
  | {
      readonly type: "turn_created";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly turnId: string;
    }
  | { readonly type: "turn_delta"; readonly text: string; readonly turnId: string }
  | {
      readonly type: "turn_done";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly turnId?: string;
    }
  | {
      readonly type: "delegation";
      readonly delegationId: string;
      readonly userTurnId?: string;
      readonly handoffId?: string;
      readonly instructions: string;
      readonly provenance: "native_live_delegation";
    }
  | { readonly type: "error"; readonly reason: LiveVoiceReason }
  // Synthesized by the owning transport, not an invented upstream session.closed event.
  | { readonly type: "closed" };

export type NativeLiveAppend = {
  readonly delegationId?: string;
  readonly channel: "quiet" | "speakable";
  readonly text: string;
};
export type NativeLiveAppendMessage = {
  readonly channel: "speakable";
  readonly content: readonly [{ readonly type: "input_text"; readonly text: string }];
} & (
  | { readonly type: "session.context.append" }
  | { readonly type: "delegation.context.append"; readonly delegation_item_id: string }
);

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length > maxBytes ||
    Buffer.byteLength(value, "utf8") > maxBytes
  )
    throw invalid();
  // JSON can contain lone UTF-16 surrogates; replacing them changes the original transcript.
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw invalid();
  }
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value)) throw invalid();
  return value;
}
function optionalId(value: unknown): string | undefined {
  return value === undefined ? undefined : id(value);
}

// Native dialect: fixtures/live-native/evidence.json; observed parent/lifecycle: parent-association.json.
export function decodeNativeLiveEvent(frame: string): NativeLiveEvent | null {
  let event: Record<string, unknown>;
  try {
    text(frame, NATIVE_LIVE_MAX_FRAME_BYTES);
    event = record(JSON.parse(frame));
  } catch {
    throw invalid();
  }
  switch (event.type) {
    case "session.started":
    case "session.updated":
      return {
        type: event.type === "session.started" ? "started" : "updated",
        sessionId: id(record(event.session).id),
      };
    case "input_transcript.added":
    case "output_transcript.added": {
      const item = record(event.item);
      const itemId = optionalId(item.id);
      return {
        type: "transcript",
        role: event.type === "input_transcript.added" ? "user" : "assistant",
        text: text(item.text, MAX_TRANSCRIPT_BYTES),
        ...(itemId === undefined ? {} : { itemId }),
      };
    }
    case "turn.created":
    case "turn.done": {
      const turn = record(event.turn);
      if (turn.role !== "user" && turn.role !== "assistant") throw invalid();
      const turnId = event.type === "turn.created" ? id(turn.id) : optionalId(turn.id);
      if (event.type === "turn.created")
        return {
          type: "turn_created",
          role: turn.role,
          turnId: turnId!,
          text: text(turn.transcript, MAX_TRANSCRIPT_BYTES),
        };
      return {
        type: "turn_done",
        role: turn.role,
        text: text(turn.transcript, MAX_TRANSCRIPT_BYTES),
        ...(turnId === undefined ? {} : { turnId }),
      };
    }
    case "turn.delta":
      return {
        type: "turn_delta",
        turnId: id(event.turn_id),
        text: text(event.delta, MAX_TRANSCRIPT_BYTES),
      };
    case "delegation.created": {
      const item = record(event.item);
      if (
        item.type !== "delegation" ||
        item.target !== "client" ||
        !Array.isArray(item.content) ||
        item.content.length === 0 ||
        item.content.length > 64
      )
        throw invalid();
      const parts = item.content.map((raw) => {
        const content = record(raw);
        if (content.type !== "input_text") throw invalid();
        return text(content.text, MAX_TRANSCRIPT_BYTES);
      });
      const instructions = text(parts.join(""), MAX_TRANSCRIPT_BYTES);
      const userTurnId = optionalId(item.user_bidi_turn_id);
      const handoffId = optionalId(item.handoff_id);
      if (!instructions.trim()) throw invalid();
      // Pinned parser discards offset_ms; its test proves presence, not association semantics.
      if (
        event.offset_ms !== undefined &&
        (!Number.isSafeInteger(event.offset_ms) || Number(event.offset_ms) < 0)
      )
        throw invalid();
      return {
        type: "delegation",
        delegationId: id(item.id),
        ...(userTurnId === undefined ? {} : { userTurnId }),
        ...(handoffId === undefined ? {} : { handoffId }),
        instructions,
        provenance: "native_live_delegation",
      };
    }
    case "error":
      // Never retain raw upstream messages/codes: they can contain credentials or URLs.
      return { type: "error", reason: "temporarily-unavailable" };
    case "session.delegation.created":
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      throw invalid();
    default:
      if (typeof event.type !== "string" || event.type.length === 0) throw invalid();
      return null;
  }
}

export function encodeNativeLiveAppend(
  input: NativeLiveAppend,
): readonly NativeLiveAppendMessage[] {
  if (input.channel !== "quiet" && input.channel !== "speakable") throw invalid();
  const value = text(
    input.text,
    input.channel === "quiet" ? NATIVE_LIVE_MAX_CONTEXT_BYTES : NATIVE_LIVE_MAX_NARRATION_BYTES,
  );
  if (!value.trim()) throw invalid();
  const delegationId = input.delegationId === undefined ? undefined : id(input.delegationId);
  // Frameless commentary can speak; passive context stays local until an explicit offer.
  if (input.channel === "quiet") return [];
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > NATIVE_LIVE_APPEND_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  chunks.push(chunk);
  return chunks.map((chunk): NativeLiveAppendMessage => ({
    ...(delegationId === undefined
      ? { type: "session.context.append" }
      : { type: "delegation.context.append", delegation_item_id: delegationId }),
    channel: "speakable",
    content: [{ type: "input_text", text: chunk }],
  }));
}

export function encodeNativeLiveCreate(input: {
  readonly offerSdp: string;
  readonly voice: string;
  readonly instructions: string;
  readonly initialContext?: string;
}) {
  try {
    return {
      sdp: decodeSdp(input.offerSdp),
      session: {
        model: LIVE_VOICE_REQUESTED_MODEL,
        instructions: text(input.instructions, NATIVE_LIVE_MAX_CONTEXT_BYTES),
        audio: { output: { voice: id(input.voice) } },
        delegation: { type: "client" },
        ...(input.initialContext
          ? {
              initial_items: [
                {
                  type: "message",
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: text(input.initialContext, NATIVE_LIVE_MAX_CONTEXT_BYTES),
                    },
                  ],
                },
              ],
            }
          : {}),
      },
    } as const;
  } catch {
    throw invalid();
  }
}

// Extract identity only. Location's host/path/query is never a request destination.
export function nativeLiveCallId(location: string): string {
  text(location, 2048);
  if (idPattern.test(location)) return location;
  try {
    const url = new URL(location, "https://fixture.invalid");
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.hash ||
      /[\s\\]/.test(location)
    )
      throw invalid();
    const queryIds = url.searchParams.getAll("call_id");
    const match = /\/(?:live|calls)\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (queryIds.length > 1 || (queryIds.length === 1 && match && queryIds[0] !== match[1]))
      throw invalid();
    if (queryIds.length === 1) return id(queryIds[0]);
    if (match) return id(match[1]);
  } catch {
    throw invalid();
  }
  throw invalid();
}

type NativeLiveCreateResponse = {
  readonly status: number;
  readonly contentType: string | null;
  readonly location: string | null;
  readonly body: string;
};

export function nativeLiveMimeCategory(contentType: string | null) {
  switch (contentType?.split(";", 1)[0]?.trim().toLowerCase()) {
    case undefined:
    case "":
      return "missing";
    case "application/sdp":
      return "sdp";
    case "text/plain":
      return "plain";
    case "application/json":
      return "json";
    case "text/html":
      return "html";
    default:
      return "other";
  }
}

// Allowlisted facts only: never include Location, headers, SDP values or schema errors.
export function nativeLiveCreateResponseDiagnostics(input: NativeLiveCreateResponse) {
  let failurePhase: "accepted" | "status" | "mime" | "location" | "sdp" = "accepted";
  const mimeCategory = nativeLiveMimeCategory(input.contentType);
  if (input.status !== 201) failurePhase = "status";
  else if (mimeCategory !== "sdp" && mimeCategory !== "plain") failurePhase = "mime";
  else {
    try {
      if (input.location === null) throw invalid();
      nativeLiveCallId(input.location);
    } catch {
      failurePhase = "location";
    }
    if (failurePhase === "accepted") {
      try {
        decodeSdp(input.body);
      } catch {
        failurePhase = "sdp";
      }
    }
  }
  const bodyBytes = Buffer.byteLength(input.body, "utf8");
  return {
    failurePhase,
    mimeCategory,
    bodyBytes,
    sdpPrefix: /^v=0\r?\n/.test(input.body),
    sdpAscii: /^[\x09\x0a\x0d\x20-\x7e]+$/.test(input.body),
    sdpWithinLimit: bodyBytes > 0 && bodyBytes <= LIVE_VOICE_MAX_SDP_BYTES,
    sdpLineEndings: !/\r(?!\n)/.test(input.body) && input.body.endsWith("\n"),
    sdpVersionLine: /(?:^|\n)v=0\r?(?:\n|$)/.test(input.body),
    sdpOriginLine: /(?:^|\n)o=/.test(input.body),
    sdpSessionLine: /(?:^|\n)s=/.test(input.body),
    sdpTimingLine: /(?:^|\n)t=/.test(input.body),
    sdpAudioLine: /(?:^|\n)m=audio /.test(input.body),
    sdpApplicationLine: /(?:^|\n)m=application /.test(input.body),
  };
}

export function decodeNativeLiveCreateResponse(input: NativeLiveCreateResponse) {
  try {
    const mimeCategory = nativeLiveMimeCategory(input.contentType);
    if (
      input.status !== 201 ||
      (mimeCategory !== "sdp" && mimeCategory !== "plain") ||
      input.location === null
    )
      throw invalid();
    return { callId: nativeLiveCallId(input.location), answerSdp: decodeSdp(input.body) };
  } catch {
    throw invalid();
  }
}

export function nativeLiveCallUrls(createUrl: string, callId: string) {
  try {
    id(callId);
    text(createUrl, 2048);
    if (/[\s\\]/.test(createUrl)) throw invalid();
    const url = new URL(createUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/v1/live")
    )
      throw invalid();
    const basePath = url.pathname.slice(0, -"/live".length);
    url.pathname = `${basePath}/realtime/calls/${callId}/hangup`;
    const hangupUrl = url.href;
    url.pathname = `${basePath}/live/${callId}`;
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { sidebandUrl: url.href, hangupUrl };
  } catch {
    throw invalid();
  }
}
