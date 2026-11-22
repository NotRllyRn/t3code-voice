import { expect, it } from "vite-plus/test";
import { acquireLiveVoiceLock } from "./liveVoiceLock";

it("holds one browser lock until released and rejects cancelled acquisition", async () => {
  const abort = new AbortController();
  const first = await acquireLiveVoiceLock(abort.signal);
  expect(first).not.toBeNull();
  try {
    expect(await acquireLiveVoiceLock(abort.signal)).toBeNull();
  } finally {
    await first?.();
  }
  const next = await acquireLiveVoiceLock(abort.signal);
  expect(next).not.toBeNull();
  await next?.();
  abort.abort();
  expect(await acquireLiveVoiceLock(abort.signal)).toBeNull();
  const lateAbort = new AbortController();
  const pending = acquireLiveVoiceLock(lateAbort.signal);
  lateAbort.abort();
  expect(await pending).toBeNull();
  const fresh = await acquireLiveVoiceLock(new AbortController().signal);
  expect(fresh).not.toBeNull();
  await fresh?.();
});
