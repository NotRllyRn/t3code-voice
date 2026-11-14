import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";
import { decodePCM, encodePCM, playedItem, Resampler } from "./pcm.js";
import { Lifecycle } from "./lifecycle.js";

test("PCM16 roundtrip clamps samples and rejects odd byte input", () => {
  NodeAssert.deepEqual(
    [...decodePCM(encodePCM(new Float32Array([-2, -0.5, 0, 0.5, 2])))],
    [-1, -0.5, 0, 0.5, 32767 / 32768],
  );
  NodeAssert.throws(() => decodePCM("AA=="));
});
test("resampling across render chunks keeps sample phase", () => {
  const input = Array.from({ length: 4096 }, (_, n) => Math.sin(n / 100));
  const whole = new Resampler(44100, 24000).push(input);
  const streaming = new Resampler(44100, 24000),
    chunks: number[] = [];
  for (let i = 0; i < input.length; i += 128)
    chunks.push(...streaming.push(input.slice(i, i + 128)));
  NodeAssert.equal(chunks.length, whole.length);
  NodeAssert.ok(chunks.every((sample, i) => Math.abs(sample - whole[i]!) < 1e-10));
});
test("truncation accounts for output latency and never reports queued audio as heard", () => {
  const timeline = [{ itemId: "item", contentIndex: 0, samples: 24000 }];
  NodeAssert.deepEqual(playedItem(timeline, 12000, 2400), {
    itemId: "item",
    contentIndex: 0,
    ms: 400,
  });
  NodeAssert.equal(playedItem(timeline, 0)?.ms, 0);
  NodeAssert.equal(playedItem([], 10000), null);
});
test("lifecycle stop is idempotent, invalidates identity, and isolates failing finalizers", async () => {
  const life = new Lifecycle();
  const session = life.begin("voice", "ws");
  let ran = 0;
  life.own(session, () => {
    throw Error("one cleanup failed");
  });
  life.own(session, () => {
    ran++;
  });
  await Promise.all([life.stop(), life.stop()]);
  NodeAssert.equal(ran, 1);
  NodeAssert.equal(life.alive(session), false);
  let completeCleanup = () => {};
  const lateCleanup = new Promise<void>((resolve) => {
    completeCleanup = resolve;
  });
  life.own(session, () => {
    ran++;
    completeCleanup();
  });
  await lateCleanup;
  NodeAssert.equal(ran, 2);
});
