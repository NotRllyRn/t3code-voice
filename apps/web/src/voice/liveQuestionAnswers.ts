import type { LiveVoiceQuestionTarget } from "@t3tools/contracts";

const key = (environmentId: string, threadId: string) => JSON.stringify([environmentId, threadId]);
type Entry = { target: LiveVoiceQuestionTarget; answer: (text: string) => void };

class LiveQuestionAnswers {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify() {
    this.listeners.forEach((listener) => listener());
  }
  get(environmentId: string, threadId?: string) {
    return threadId ? (this.entries.get(key(environmentId, threadId))?.target ?? null) : null;
  }
  register(environmentId: string, threadId: string, entry: Entry) {
    const scope = key(environmentId, threadId);
    this.entries.set(scope, entry);
    this.notify();
    return () => {
      if (this.entries.get(scope) !== entry) return;
      this.entries.delete(scope);
      this.notify();
    };
  }
  answer(
    environmentId: string,
    threadId: string | undefined,
    target: LiveVoiceQuestionTarget,
    text: string,
  ) {
    if (!threadId || !text.trim()) return;
    const scope = key(environmentId, threadId);
    const entry = this.entries.get(scope);
    if (
      entry?.target.nonce !== target.nonce ||
      entry.target.requestId !== target.requestId ||
      entry.target.questionId !== target.questionId
    )
      return;
    this.entries.delete(scope);
    this.notify();
    entry.answer(text);
  }
}
export const liveQuestionAnswers = new LiveQuestionAnswers();
