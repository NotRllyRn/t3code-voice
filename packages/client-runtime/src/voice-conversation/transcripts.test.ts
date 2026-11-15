import { expect, test } from "vite-plus/test";
import { LiveTranscripts } from "./transcripts.ts";

test("live input is provisional; final replaces rather than appends; replayed deltas cannot overwrite", () => {
  const texts = new LiveTranscripts();
  const input = (type: string, data: object) => texts.input({ type, item_id: "first", ...data });
  expect(input("input_audio_buffer.committed", {})).toEqual({
    transcript: "",
    transcriptStatus: "live",
  });
  expect(
    input("conversation.item.input_audio_transcription.delta", { delta: "Par" })?.transcript,
  ).toBe("Par");
  expect(
    input("conversation.item.input_audio_transcription.delta", { delta: "tial" })?.transcript,
  ).toBe("Partial");
  expect(
    input("conversation.item.input_audio_transcription.completed", { transcript: "Correct final" }),
  ).toEqual({ transcript: "Correct final", transcriptStatus: "saving" });
  expect(
    input("conversation.item.input_audio_transcription.delta", { delta: "stale" })?.transcript,
  ).toBe("Correct final");
  expect(input("agent.recorded", {})).toEqual({
    transcript: "Correct final",
    transcriptStatus: "saved",
  });
  texts.input({ type: "input_audio_buffer.committed", item_id: "next" });
  expect(
    input("conversation.item.input_audio_transcription.completed", { transcript: "Correct final" })
      ?.transcript,
  ).toBe("");
});

test("generated output deltas have content ownership and authoritative finals", () => {
  const texts = new LiveTranscripts();
  const base = { response_id: "response", item_id: "item", content_index: 0 };
  expect(
    texts.reply({ ...base, type: "response.output_audio_transcript.delta", delta: "Hello" }),
  ).toEqual({ reply: "Hello", replyPartial: true });
  expect(
    texts.reply({ ...base, type: "response.output_audio_transcript.done", transcript: "Hello!" }),
  ).toEqual({ reply: "Hello!", replyPartial: false });
  expect(
    texts.reply({ ...base, type: "response.output_audio_transcript.delta", delta: " stale" })
      ?.reply,
  ).toBe("Hello!");
  texts.reply({ ...base, item_id: "new", type: "response.audio_transcript.delta", delta: "New" });
  expect(
    texts.reply({ ...base, type: "response.output_audio_transcript.done", transcript: "Hello!" })
      ?.reply,
  ).toBe("New");
});

test("partial text and live item maps are bounded per lifetime", () => {
  const texts = new LiveTranscripts();
  texts.input({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "first",
    delta: "a".repeat(16000),
  });
  expect(() =>
    texts.input({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "first",
      delta: "b",
    }),
  ).toThrow();
  for (let i = 1; i < 64; i++)
    texts.input({ type: "input_audio_buffer.committed", item_id: `item_${i}` });
  expect(() =>
    texts.input({ type: "input_audio_buffer.committed", item_id: "overflow" }),
  ).toThrow();
});
