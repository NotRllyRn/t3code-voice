import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const LIVE_VOICE_PATH = "/api/voice/live";
export const LIVE_VOICE_PROTOCOL = "cpa-codex-live";
export const LIVE_VOICE_REQUESTED_MODEL = "gpt-live-1.1-codex";
export const LIVE_VOICE_MAX_FRAME_BYTES = 72 * 1024;
export const LIVE_VOICE_MAX_SDP_BYTES = 64 * 1024;
export const LIVE_VOICE_MAX_CAPTION_BYTES = 16 * 1024;
export const LIVE_VOICE_CONNECT_BUDGET_MS = 180_000;
export const LIVE_VOICE_MAX_CREATE_ATTEMPTS = 2;
export const LIVE_VOICE_CREATE_TIMEOUT_MS = 30_000;
export const LIVE_VOICE_READY_TIMEOUT_MS = 15_000;
// UX policy informed by one refresh recovery, not a provider refresh guarantee.
export const LIVE_VOICE_REFRESH_WAIT_MS = 90_000;
export const LIVE_VOICE_HEARTBEAT_INTERVAL_MS = 15_000;
export const LIVE_VOICE_HEARTBEAT_TIMEOUT_MS = 45_000;
export const LIVE_VOICE_STOP_TIMEOUT_MS = 12_000;

export const LiveVoiceCleanupResult = Schema.Literals(["acknowledged", "failed", "unknown"]);
export type LiveVoiceCleanupResult = typeof LiveVoiceCleanupResult.Type;

const utf8 = new TextEncoder();
const boundedText = (maxBytes: number) =>
  Schema.String.check(
    Schema.isMaxLength(maxBytes),
    Schema.makeFilter((value) => utf8.encode(value).byteLength <= maxBytes),
  );
export const LiveVoiceId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));
const timestamp = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const LiveVoiceSdp = boundedText(LIVE_VOICE_MAX_SDP_BYTES).check(
  Schema.isMinLength(1),
  Schema.isPattern(/^v=0\r?\n/),
  Schema.isPattern(/^[\x09\x0a\x0d\x20-\x7e]+$/),
);

// Binding is authorized separately on the control route, never inferred from peer/media events.
export const LiveVoiceDraft = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type LiveVoiceDraft = typeof LiveVoiceDraft.Type;
export const LiveVoiceBinding = Schema.Union([
  Schema.Struct({ threadId: ThreadId }),
  Schema.Struct({ draft: LiveVoiceDraft }),
]);
export type LiveVoiceBinding = typeof LiveVoiceBinding.Type;

export const LiveVoicePhase = Schema.Literals([
  "connecting",
  "refresh_wait",
  "connected",
  "stopping",
  "idle",
  "error",
]);
export type LiveVoicePhase = typeof LiveVoicePhase.Type;
export const LiveVoiceReason = Schema.Literals([
  "auth-required",
  "environment-auth-required",
  "forbidden",
  "quota",
  "rate-limited",
  "unsupported-provider",
  "unsupported-endpoint",
  "unsupported-model",
  "incompatible-protocol",
  "invalid-offer",
  "refresh-pending",
  "temporarily-unavailable",
  "timeout",
  "connection-changed",
  "media-denied",
  "playback-blocked",
  "disconnected",
]);
export type LiveVoiceReason = typeof LiveVoiceReason.Type;
export class LiveVoiceStartupError extends Schema.TaggedError<LiveVoiceStartupError>()(
  "LiveVoiceStartupError",
  { reason: LiveVoiceReason },
) {
  override get message() {
    return "Live voice could not start.";
  }
}
export const LiveVoiceCapability = Schema.Struct({
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
  protocol: Schema.Literal(LIVE_VOICE_PROTOCOL),
  requestedModel: Schema.Literal(LIVE_VOICE_REQUESTED_MODEL),
  effectiveModel: Schema.NullOr(boundedText(160)),
});
export type LiveVoiceCapability = typeof LiveVoiceCapability.Type;

export const LiveVoiceClientEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("live.start"),
    attemptId: LiveVoiceId,
    offerSdp: LiveVoiceSdp,
  }),
  Schema.Struct({
    type: Schema.Literal("live.peer"),
    attemptId: LiveVoiceId,
    state: Schema.Literals(["connected", "failed"]),
  }),
  Schema.Struct({ type: Schema.Literal("live.stop") }),
  Schema.Struct({ type: Schema.Literal("live.mute"), muted: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("live.heartbeat") }),
]);
export type LiveVoiceClientEvent = typeof LiveVoiceClientEvent.Type;

export const LiveVoiceServerEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("live.cleanup"),
    sessionId: LiveVoiceId,
    result: LiveVoiceCleanupResult,
  }),
  Schema.Struct({
    type: Schema.Literal("live.answer"),
    sessionId: LiveVoiceId,
    attemptId: LiveVoiceId,
    answerSdp: LiveVoiceSdp,
  }),
  Schema.Struct({
    type: Schema.Literal("live.status"),
    sessionId: LiveVoiceId,
    phase: LiveVoicePhase,
    attemptId: Schema.optionalKey(LiveVoiceId),
    reason: Schema.optionalKey(LiveVoiceReason),
    retryAt: Schema.optionalKey(timestamp),
    deadlineAt: Schema.optionalKey(timestamp),
    capability: Schema.optionalKey(LiveVoiceCapability),
  }),
  Schema.Struct({ type: Schema.Literal("live.bound"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("live.caption"),
    sessionId: LiveVoiceId,
    role: Schema.Literals(["user", "assistant"]),
    segmentId: LiveVoiceId,
    revision: NonNegativeInt,
    text: boundedText(LIVE_VOICE_MAX_CAPTION_BYTES),
    startMs: Schema.optionalKey(timestamp),
    endMs: Schema.optionalKey(timestamp),
    messageId: Schema.optionalKey(MessageId),
    committed: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("live.agent"),
    status: Schema.Literals(["accepted", "queued", "started", "waiting", "completed", "failed"]),
    messageId: Schema.optionalKey(MessageId),
    runId: Schema.optionalKey(RunId),
  }),
  Schema.Struct({
    type: Schema.Literal("live.closed"),
    sessionId: LiveVoiceId,
    reason: Schema.optionalKey(LiveVoiceReason),
  }),
]);
export type LiveVoiceServerEvent = typeof LiveVoiceServerEvent.Type;

const decodeClient = Schema.decodeUnknownSync(LiveVoiceClientEvent, { onExcessProperty: "error" });
const decodeServer = Schema.decodeUnknownSync(LiveVoiceServerEvent, { onExcessProperty: "error" });
function decodeFrame<A>(frame: string, decode: (value: unknown) => A): A {
  try {
    if (
      frame.length > LIVE_VOICE_MAX_FRAME_BYTES ||
      utf8.encode(frame).byteLength > LIVE_VOICE_MAX_FRAME_BYTES
    )
      throw new Error();
    return decode(JSON.parse(frame));
  } catch {
    // Schema/JSON errors can contain private upstream or hostile client payloads.
    throw new Error("Invalid Live control frame");
  }
}
export const decodeLiveVoiceClientEvent = (frame: string): LiveVoiceClientEvent =>
  decodeFrame(frame, decodeClient);
export const decodeLiveVoiceServerEvent = (frame: string): LiveVoiceServerEvent =>
  decodeFrame(frame, decodeServer);
