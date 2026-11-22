import type { LiveVoiceServerEvent } from "@t3tools/contracts";

export type LiveCaption = Extract<LiveVoiceServerEvent, { type: "live.caption" }>;
export interface LiveCaptionSnapshot {
  readonly keys: ReadonlyArray<string>;
  readonly captions: ReadonlyArray<LiveCaption>;
  readonly overflow: boolean;
}
const EMPTY: LiveCaptionSnapshot = { keys: [], captions: [], overflow: false };
export const liveCaptionKey = (environmentId: string, threadId?: string, draftId?: string) =>
  JSON.stringify([environmentId, threadId ? ["thread", threadId] : ["draft", draftId ?? "draft"]]);

/** Ephemeral presentation only: never used to create or amend a coding request. */
export class LiveCaptionStore {
  private value = EMPTY;
  private owner: symbol | undefined;
  private accepting = false;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.value;
  private publish(value: LiveCaptionSnapshot) {
    this.value = value;
    this.listeners.forEach((notify) => notify());
  }
  begin(owner: symbol, key: string) {
    this.owner = owner;
    this.accepting = true;
    this.publish({ keys: [key], captions: [], overflow: false });
  }
  bind(owner: symbol, key: string) {
    if (this.owner === owner && !this.value.keys.includes(key))
      this.publish({ ...this.value, keys: [...this.value.keys, key] });
  }
  caption(owner: symbol, caption: LiveCaption) {
    if (this.owner !== owner || !this.accepting) return;
    const same = (previous: LiveCaption) =>
      previous.sessionId === caption.sessionId &&
      previous.role === caption.role &&
      previous.segmentId === caption.segmentId;
    const previous = this.value.captions.find(same);
    if (previous && previous.revision >= caption.revision) return;
    let captions = previous
      ? this.value.captions.map((item) => (same(item) ? caption : item))
      : [...this.value.captions, caption];
    let overflow = this.value.overflow;
    let size = captions.reduce((total, item) => total + item.text.length, 0);
    while (captions.length > 64 || size > 65_536) {
      size -= captions[0]!.text.length;
      captions = captions.slice(1);
      overflow = true;
    }
    this.publish({ ...this.value, captions, overflow });
  }
  /** Keep only mapped, application-committed previews until canonical history catches up. */
  finish(owner: symbol) {
    if (this.owner !== owner) return;
    this.accepting = false;
    const captions = this.value.captions.filter(
      (caption) => caption.committed && caption.messageId,
    );
    this.publish(captions.length ? { ...this.value, captions, overflow: false } : EMPTY);
  }
  reconcile(key: string, messageIds: ReadonlySet<string>) {
    if (this.accepting || !this.value.keys.includes(key)) return;
    const captions = this.value.captions.filter(
      (caption) => !caption.messageId || !messageIds.has(caption.messageId),
    );
    if (captions.length !== this.value.captions.length)
      this.publish(captions.length ? { ...this.value, captions } : EMPTY);
  }
  clear(owner: symbol) {
    if (this.owner === owner) {
      this.owner = undefined;
      this.publish(EMPTY);
    }
  }
}
export const liveCaptions = new LiveCaptionStore();
