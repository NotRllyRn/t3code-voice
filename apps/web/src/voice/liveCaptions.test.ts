import { expect, it } from "vite-plus/test";
import { MessageId, type LiveVoiceServerEvent } from "@t3tools/contracts";
import { LiveCaptionStore, liveCaptionKey } from "./liveCaptions";
type Caption = Extract<LiveVoiceServerEvent, { type: "live.caption" }>;
const caption = (revision: number, patch: Partial<Caption> = {}): Caption => ({
  type: "live.caption",
  sessionId: "session_1",
  role: "user",
  segmentId: "input_1",
  revision,
  text: "Fictional partial",
  committed: false,
  ...patch,
});
it("isolates owners and draft/thread bindings; applies only higher revisions", () => {
  const store = new LiveCaptionStore();
  const owner = Symbol();
  const stale = Symbol();
  const draft = liveCaptionKey("env", undefined, "draft");
  const thread = liveCaptionKey("env", "thread");
  store.begin(owner, draft);
  store.caption(owner, caption(2));
  store.caption(owner, caption(1, { text: "Stale" }));
  store.caption(stale, caption(3));
  expect(store.getSnapshot().captions).toEqual([caption(2)]);
  store.bind(owner, thread);
  expect(store.getSnapshot().keys).toEqual([draft, thread]);
  store.clear(stale);
  expect(store.getSnapshot().captions).toHaveLength(1);
  store.begin(stale, liveCaptionKey("other", "thread"));
  store.caption(owner, caption(4));
  expect(store.getSnapshot().captions).toHaveLength(0);
});
it("bounds segment count and aggregate characters while surfacing overflow", () => {
  const store = new LiveCaptionStore();
  const owner = Symbol();
  store.begin(owner, "key");
  for (let index = 0; index < 100; index++)
    store.caption(owner, caption(0, { segmentId: `segment_${index}`, text: "a".repeat(16_384) }));
  expect(store.getSnapshot().captions).toHaveLength(4);
  expect(store.getSnapshot().overflow).toBe(true);
});
it("Stop retains only canonical-mapped committed previews, then reconciliation releases them without a fake final", () => {
  const store = new LiveCaptionStore();
  const owner = Symbol();
  store.begin(owner, "key");
  store.caption(owner, caption(0));
  const committed = caption(1, { messageId: MessageId.make("canonical_1"), committed: true });
  store.caption(owner, committed);
  store.caption(owner, caption(1, { role: "assistant", segmentId: "output_1" }));
  store.finish(owner);
  expect(store.getSnapshot().captions).toEqual([committed]);
  store.caption(owner, caption(9));
  expect(store.getSnapshot().captions).toEqual([committed]);
  store.reconcile("wrong key", new Set(["canonical_1"]));
  expect(store.getSnapshot().captions).toHaveLength(1);
  store.reconcile("key", new Set(["canonical_1"]));
  expect(store.getSnapshot().captions).toHaveLength(0);
});
