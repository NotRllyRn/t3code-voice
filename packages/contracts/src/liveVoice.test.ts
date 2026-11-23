import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  LiveVoiceBinding,
  LiveVoicePreferences,
  LIVE_VOICE_VOICES,
  LIVE_VOICE_MAX_FRAME_BYTES,
  LIVE_VOICE_MAX_SDP_BYTES,
  decodeLiveVoiceClientEvent,
  decodeLiveVoiceServerEvent,
} from "./liveVoice.ts";
import { OrchestrationV2VoiceMessage } from "./orchestrationV2.ts";

const offerSdp = "v=0\r\ns=Fictional offer\r\n";
describe("Live control boundary", () => {
  it.each([
    { type: "live.start", attemptId: "attempt-1", offerSdp },
    { type: "live.peer", attemptId: "attempt-1", state: "connected" },
    { type: "live.peer", attemptId: "attempt-1", state: "failed" },
    { type: "live.question", target: null },
    {
      type: "live.question",
      target: { requestId: "question", questionId: "color", nonce: "binding" },
    },
    { type: "live.stop" },
    { type: "live.mute", muted: true },
    { type: "live.heartbeat" },
    { type: "live.preferences", notifications: "terminal" },
    { type: "live.preferences", notifications: "progress" },
  ])("decodes the bounded control $type", (event) => {
    expect(decodeLiveVoiceClientEvent(JSON.stringify(event))).toEqual(event);
  });

  it.each([
    { type: "live.start", attemptId: "attempt-1", offerSdp, endpoint: "https://poison.invalid" },
    { type: "live.start", attemptId: "attempt-1", offerSdp, apiKey: "fictional-poison-key" },
    { type: "live.start", attemptId: "attempt-1", offerSdp, model: "other-model" },
    { type: "live.start", attemptId: "attempt-1", offerSdp, taskText: "Do not execute this." },
    { type: "live.peer", attemptId: "attempt-1", state: "ready" },
    { type: "live.peer", attemptId: "attempt-1", state: "connected", delegationId: "task-1" },
    { type: "delegation.created", item: {} },
    { type: "live.mute", muted: "true" },
    {
      type: "live.question",
      target: { requestId: "question", questionId: "color", nonce: "binding", decision: "accept" },
    },
    { type: "live.preferences" },
    { type: "live.preferences", notifications: "all" },
    { type: "live.preferences", notifications: "progress", voice: "cove" },
    { type: "live.preferences", notifications: "terminal", microphoneId: "other" },
    { type: "live.stop", session: { headers: { authorization: "fictional-poison-key" } } },
    { type: "live.start", attemptId: "../bad", offerSdp },
    { type: "live.start", attemptId: "attempt-1", offerSdp: "not SDP" },
    {
      type: "live.start",
      attemptId: "attempt-1",
      offerSdp: "v=0\n" + "x".repeat(LIVE_VOICE_MAX_SDP_BYTES),
    },
    null,
    [],
  ])("rejects malformed controls and extra authority %#", (event) => {
    expect(() => decodeLiveVoiceClientEvent(JSON.stringify(event))).toThrow(
      "Invalid Live control frame",
    );
  });

  it("bounds whole frames in UTF-8 bytes and hides raw decoder errors", () => {
    for (const frame of [
      "x".repeat(LIVE_VOICE_MAX_FRAME_BYTES + 1),
      JSON.stringify({ type: "live.stop", poison: "界".repeat(LIVE_VOICE_MAX_FRAME_BYTES / 2) }),
      '{"fictional-poison-key":',
    ]) {
      expect(() => decodeLiveVoiceClientEvent(frame)).toThrow(/^Invalid Live control frame$/);
    }
  });

  it("keeps server failures finite and credential-free, and captions revisioned", () => {
    const status = {
      type: "live.status",
      sessionId: "app-session",
      phase: "refresh_wait",
      reason: "refresh-pending",
      attemptId: "attempt-2",
      retryAt: 90_000,
      deadlineAt: 180_000,
      capability: {
        environmentId: "environment-fictional",
        providerInstanceId: "codex",
        protocol: "cpa-codex-live",
        requestedModel: "gpt-live-1.1-codex",
        effectiveModel: null,
      },
    };
    const caption = {
      type: "live.caption",
      sessionId: "app-session",
      role: "user",
      segmentId: "segment-1",
      revision: 2,
      text: "Fictional correction",
      committed: false,
    };
    expect(decodeLiveVoiceServerEvent(JSON.stringify(status))).toEqual(status);
    expect(decodeLiveVoiceServerEvent(JSON.stringify(caption))).toEqual(caption);
    for (const event of [
      { ...status, reason: "refresh_failed: fictional-poison-key" },
      { ...status, headers: { authorization: "fictional-poison-key" } },
      { ...status, capability: { ...status.capability, createUrl: "https://poison.invalid" } },
      { ...caption, revision: -1 },
      { ...caption, startMs: Infinity },
      { ...caption, role: "system" },
      { ...caption, text: "界".repeat(6_000) },
    ]) {
      expect(() => decodeLiveVoiceServerEvent(JSON.stringify(event))).toThrow(
        /^Invalid Live control frame$/,
      );
    }
  });

  it.each(["acknowledged", "failed", "unknown"] as const)(
    "keeps cleanup %s separate from Live closure",
    (result) => {
      const event = { type: "live.cleanup", sessionId: "fictional-session", result };
      expect(decodeLiveVoiceServerEvent(JSON.stringify(event))).toEqual(event);
      for (const invalid of [
        { ...event, result: "404 means success" },
        { ...event, error: "private-detail" },
      ])
        expect(() => decodeLiveVoiceServerEvent(JSON.stringify(invalid))).toThrow(
          "Invalid Live control frame",
        );
    },
  );

  it("preserves legacy voice records while distinguishing application-frozen Live windows", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2VoiceMessage);
    const legacy = {
      sessionId: "session-fictional",
      itemId: "item-fictional",
      sequence: 0,
      textKind: "final_user_transcript",
      delivery: "unknown",
    };
    expect(decode(legacy)).toMatchObject(legacy);
    expect(decode({ ...legacy, transcriptFinality: "application_frozen" })).toMatchObject({
      ...legacy,
      transcriptFinality: "application_frozen",
    });
    expect(() => decode({ ...legacy, transcriptFinality: "heard" })).toThrow();
  });
});

it("bounds reconnect hints and never accepts result content or draft hints", () => {
  const decode = Schema.decodeUnknownSync(LiveVoiceBinding, { onExcessProperty: "error" });
  expect(decode({ threadId: "same-thread", resumeRunIds: ["run"] })).toMatchObject({
    resumeRunIds: ["run"],
  });
  expect(() =>
    decode({
      threadId: "same-thread",
      resumeRunIds: Array.from({ length: 33 }, (_, i) => `run-${i}`),
    }),
  ).toThrow();
  expect(() =>
    decode({ threadId: "same-thread", resumeRunIds: ["run"], result: "forged" }),
  ).toThrow();
});

it("carries a reserved draft identity without granting thread reuse authority", () => {
  const decode = Schema.decodeUnknownSync(LiveVoiceBinding, { onExcessProperty: "error" });
  const draft = {
    modelSelection: { instanceId: "codex", model: "model-fictional" },
    runtimeMode: "full-access",
    interactionMode: "default",
  };
  expect(decode({ draft })).toEqual({ draft });
  expect(decode({ draft: { ...draft, threadId: "reserved-thread" } })).toEqual({
    draft: { ...draft, threadId: "reserved-thread" },
  });
  expect(() => decode({ draft: { ...draft, threadId: "" } })).toThrow();
  expect(() => decode({ draft: { ...draft, reuseExistingThread: true } })).toThrow();
});

it("negotiates only native voice and notification preferences", () => {
  const decode = Schema.decodeUnknownSync(LiveVoicePreferences, { onExcessProperty: "error" });
  for (const voice of LIVE_VOICE_VOICES)
    expect(decode({ voice, notifications: "terminal" })).toEqual({
      voice,
      notifications: "terminal",
    });
  for (const invalid of [
    { voice: "maple", notifications: "terminal", speed: 1.5 },
    { voice: "maple", notifications: "terminal", instructions: "override" },
    { voice: "unknown", notifications: "progress" },
    { voice: "maple", notifications: "all" },
  ])
    expect(() => decode(invalid)).toThrow();
});
