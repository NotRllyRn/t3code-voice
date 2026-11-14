import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientEvent,
  MAX_TURN_SAMPLES,
  serverEvent,
  sessionUpdate,
  upstreamUrl,
  VoiceBudget,
} from "./protocol.ts";

test("only fixed audio commands pass; no session changes, tools, text, or endpoint selection", () => {
  for (const e of [
    { type: "session.update", session: { tools: [{}] } },
    { type: "conversation.item.create", item: { role: "system" } },
    { type: "response.create", response: { tools: [{}] } },
    { type: "input_audio_buffer.clear", url: "ws://attacker" },
    { type: "response.cancel", response_id: {} },
    { type: "input_audio_buffer.append", audio: "!" },
    { type: "input_audio_buffer.append", audio: "AA==" },
    { type: "input_audio_buffer.append", audio: "" },
    { type: "conversation.item.truncate", item_id: "item", content_index: 0, audio_end_ms: -1 },
  ])
    assert.throws(() => clientEvent(e));
  assert.equal(
    clientEvent({ type: "input_audio_buffer.append", audio: "AAAAAA==" }).type,
    "input_audio_buffer.append",
  );
  assert.equal(
    clientEvent({ type: "response.cancel", response_id: "resp_123" }).type,
    "response.cancel",
  );
  assert.equal(
    clientEvent({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        max_output_tokens: 512,
        metadata: { voice_turn: "turn_123" },
      },
    }).type,
    "response.create",
  );
});

test("upstream must be encrypted except loopback; no embedded URL credentials", () => {
  assert.equal(
    upstreamUrl("wss://voice.example/v1/realtime?model=realtime"),
    "wss://voice.example/v1/realtime?model=realtime",
  );
  assert.equal(upstreamUrl("ws://127.0.0.1:9000/v1/realtime"), "ws://127.0.0.1:9000/v1/realtime");
  for (const url of [
    "ws://voice.example/",
    "https://voice.example/",
    "wss://key:secret@voice.example/",
    "wss://voice.example/#token",
  ])
    assert.throws(() => upstreamUrl(url));
});

test("server owns separate tool-free PCM session and explicit turn detection", () => {
  const update = sessionUpdate("alloy", "whisper-1");
  assert.deepEqual(update.session.tools, []);
  assert.equal(update.session.tool_choice, "none");
  assert.equal(update.session.audio.input.turn_detection, null);
  assert.equal(update.session.audio.input.format.rate, 24000);
  assert.equal("transcription" in sessionUpdate("alloy", "").session.audio.input, false);
});

test("outbound whitelist rebuilds events and never returns upstream secrets/errors/tools", () => {
  assert.throws(
    () => serverEvent({ type: "error", error: { message: "Bearer SECRET" } }),
    (error) => !String(error).includes("SECRET"),
  );
  assert.equal(
    serverEvent({ type: "response.function_call_arguments.done", arguments: "SECRET" }),
    null,
  );
  const event = serverEvent({
    type: "response.created",
    secret: "SECRET",
    response: {
      id: "resp_1",
      output: [{ arguments: "SECRET" }],
      metadata: { voice_turn: "turn_1", key: "SECRET" },
    },
  });
  assert.equal(JSON.stringify(event).includes("SECRET"), false);
  assert.deepEqual(serverEvent({ type: "session.updated", session: { key: "SECRET" } }), {
    type: "relay.ready",
  });
  assert.throws(() => serverEvent({ type: "response.audio.delta", delta: "A".repeat(96001) }));
});

test("audio and response budgets hold even for a malicious authenticated browser", () => {
  const budget = new VoiceBudget();
  let now = 0;
  const accept = (e: Record<string, unknown>) => budget.accept(e, (now += 20));
  assert.throws(() => accept({ type: "input_audio_buffer.commit" }));
  const chunk = Buffer.alloc(2400).toString("base64");
  for (let i = 0; i < MAX_TURN_SAMPLES / 1200; i++)
    accept({ type: "input_audio_buffer.append", audio: chunk });
  assert.throws(() => accept({ type: "input_audio_buffer.append", audio: chunk }));
  accept({ type: "input_audio_buffer.clear" });
  for (let i = 0; i < 32; i++) accept({ type: "response.create" });
  assert.throws(() => accept({ type: "response.create" }));
});

test("command flood is bounded independently of audio clears", () => {
  const budget = new VoiceBudget();
  for (let i = 0; i < 100; i++) budget.accept({ type: "input_audio_buffer.clear" }, 0);
  assert.throws(() => budget.accept({ type: "input_audio_buffer.clear" }, 0), /rate limit/);
  assert.doesNotThrow(() => budget.accept({ type: "input_audio_buffer.clear" }, 1000));
});
