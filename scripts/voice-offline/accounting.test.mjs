import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
const assert = NodeAssert;
const { test } = NodeTest;
import { assertTruncate, createPlaybackLedger } from "./accounting.mjs";

test("cumulative progress counts once per node/epoch and resets after flush", () => {
  const ledger = createPlaybackLedger();
  const identity = { item_id: "fictional-audio", content_index: 0 };
  ledger.enqueue(1, 0, 12000, identity);
  for (const played of [0, 256, 512, 512, 400]) ledger.progress(1, 0, played);
  assert.equal(ledger.snapshot().progressSamples, 512);
  ledger.flush(1, 0, { id: 1, epoch: 1 }, 240);
  ledger.flushed(1, { id: 1, epoch: 1, played: 576 });
  ledger.enqueue(1, 1, 12000, identity);
  for (const played of [0, 64, 128]) ledger.progress(1, 1, played);
  ledger.enqueue(2, 0, 12000, identity);
  ledger.progress(2, 0, 64);
  assert.equal(ledger.snapshot().progressSamples, 704);
  assert.equal(ledger.snapshot().consumedSamples, 768);
  assert.equal(ledger.epochs[0].consumed, 576);
  assert.throws(() => ledger.flushed(1, { id: 1, epoch: 1, played: 576 }), /Unmatched flush/);
});

test("mock rejects wrong truncate identity/endpoint and missing flush acknowledgement", () => {
  const ledger = createPlaybackLedger();
  ledger.enqueue(1, 0, 12000, { item_id: "fictional-audio", content_index: 2 });
  ledger.progress(1, 0, 256);
  ledger.flush(1, 0, { id: 1, epoch: 1 }, 240);
  const event = { item_id: "fictional-audio", content_index: 2, audio_end_ms: 190 };
  assert.throws(() => assertTruncate(event, ledger.flushes[0]), /without acknowledged/);
  ledger.flushed(1, { id: 1, epoch: 1, played: 4800 });
  const flush = ledger.flushes[0];
  assertTruncate(event, flush);
  assert.throws(
    () => assertTruncate({ ...event, item_id: "wrong-item" }, flush),
    /identity mismatch/,
  );
  assert.throws(() => assertTruncate({ ...event, content_index: 0 }, flush), /identity mismatch/);
  assert.throws(() => assertTruncate({ ...event, audio_end_ms: 191 }, flush), /endpoint mismatch/);
  assertTruncate({ ...event, audio_end_ms: 0 }, { ...flush, latencySamples: 5000 });
  assertTruncate({ ...event, audio_end_ms: 500 }, { ...flush, played: 13000, latencySamples: 0 });
});
