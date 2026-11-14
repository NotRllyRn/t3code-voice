import { deadline } from "./lifecycle.js";
import type { AudioEvent, PlayedAudio, VoiceMedia } from "./media.js";

import * as SecureRandom from "effect/crypto/SecureRandom";

export interface RealtimeEvent {
  type: string;
  response?: { id: string; status?: string; metadata?: { voice_turn?: string } };
  response_id?: string;
  item_id?: string;
  content_index?: number;
  part?: { type: string };
  delta?: string;
  transcript?: string;
}
type Cut = { ready: boolean; sent: boolean; played: PlayedAudio | null };

/** WS-only version of the reviewed push-to-talk protocol. No speculative VAD or tools. */
export class Conversation {
  private turn: string | null = null;
  private response: string | null = null;
  private generating = false;
  private pending = false;
  private closed = false;
  private count = 0;
  private blocked = new Set<string>();
  private waiters = new Set<() => void>();
  private audioItems = new Map<string, PlayedAudio>();
  private cuts = new Map<string, Cut>();
  private cut: Cut | null = null;
  private interrupting: Promise<void> | null = null;
  constructor(
    private send: (event: object) => void,
    private output: Pick<VoiceMedia, "allow" | "silence" | "enqueue">,
    private fail: (message: string) => void,
  ) {}
  private changed() {
    for (const notify of this.waiters) notify();
  }
  private async waitUntil(predicate: () => boolean) {
    if (predicate()) return;
    const notify = () => {
      if (predicate() || this.closed) resolve();
    };
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
      this.waiters.add(notify);
    });
    await deadline(promise, 2000, "Interruption barrier timed out").finally(() =>
      this.waiters.delete(notify),
    );
  }
  interrupt(): Promise<void> {
    if (this.interrupting) return this.interrupting;
    this.interrupting = deadline(this.runInterrupt(), 2000, "Interruption barrier timed out")
      .catch((error) => {
        this.close();
        this.fail("Voice interruption failed; conversation stopped");
        throw error;
      })
      .finally(() => {
        this.interrupting = null;
      });
    return this.interrupting;
  }
  private async runInterrupt() {
    if (this.closed) return;
    const old = this.pending ? null : this.response;
    const cut = old
      ? (this.cuts.get(old) ?? { ready: false, sent: false, played: null })
      : { ready: false, sent: false, played: null };
    this.cut = cut;
    if (old) {
      this.cuts.set(old, cut);
      this.blocked.add(old);
    }
    this.turn = null;
    // Local audio stops before any network acknowledgment. Coding is never interrupted here.
    const flushed = this.output.silence();
    if (this.generating && old) this.send({ type: "response.cancel", response_id: old });
    const played = await deadline(flushed, 200, "Local audio flush timed out");
    if (this.closed) return;
    cut.ready = true;
    cut.played = played;
    for (const [responseId, target] of this.cuts) if (target === cut) this.truncate(responseId);
    const ready = () => !this.pending && !this.generating;
    do {
      await this.waitUntil(ready);
    } while (!this.closed && !ready());
  }
  private truncate(responseId: string) {
    const cut = this.cuts.get(responseId);
    if (!cut?.ready || cut.sent || this.closed) return;
    const item = cut.played ?? this.audioItems.get(responseId);
    if (!item) return;
    cut.sent = true;
    this.send({
      type: "conversation.item.truncate",
      item_id: item.itemId,
      content_index: item.contentIndex,
      audio_end_ms: item.ms,
    });
  }
  private rememberAudio(e: RealtimeEvent) {
    const responseId = e.response_id;
    if (
      !responseId ||
      (responseId !== this.response && !this.cuts.has(responseId)) ||
      !e.item_id ||
      !Number.isInteger(e.content_index)
    )
      return;
    this.audioItems.set(responseId, { itemId: e.item_id, contentIndex: e.content_index!, ms: 0 });
    this.truncate(responseId);
  }
  createResponse() {
    if (this.closed || this.pending || this.generating || this.interrupting)
      throw Error("Previous voice response is still active");
    if (++this.count > 32) throw Error("Start a new voice conversation");
    this.turn = `turn_${this.count}_${SecureRandom.uuidV4Unsafe()}`;
    this.pending = true;
    this.cut = null;
    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        max_output_tokens: 512,
        metadata: { voice_turn: this.turn },
      },
    });
  }
  accepts(responseId?: string) {
    return (
      !!this.turn && !!responseId && responseId === this.response && !this.blocked.has(responseId)
    );
  }
  event(e: RealtimeEvent) {
    if (this.closed) return;
    switch (e.type) {
      case "error":
      case "relay.error":
        this.fail("Voice upstream failed; conversation stopped");
        break;
      case "response.created": {
        const response = e.response;
        if (!response) throw Error("Invalid voice response");
        if (!this.turn || response.metadata?.voice_turn !== this.turn) {
          this.blocked.add(response.id);
          if (this.pending) {
            this.pending = false;
            this.response = response.id;
            this.generating = true;
            if (this.cut) {
              this.cuts.set(response.id, this.cut);
              this.truncate(response.id);
            }
          }
          this.send({ type: "response.cancel", response_id: response.id });
          return;
        }
        this.pending = false;
        this.response = response.id;
        this.generating = true;
        this.output.allow();
        break;
      }
      case "response.done":
        if (e.response?.id === this.response) {
          this.generating = false;
          this.changed();
        }
        if (e.response?.status === "failed") this.fail("Voice response failed");
        break;
      case "response.content_part.added":
        if (e.part?.type === "audio") this.rememberAudio(e);
        break;
      case "response.audio.delta":
      case "response.output_audio.delta":
        this.rememberAudio(e);
        if (
          this.turn &&
          e.response_id === this.response &&
          !this.blocked.has(e.response_id!) &&
          typeof e.delta === "string" &&
          e.item_id &&
          Number.isInteger(e.content_index)
        )
          this.output.enqueue(e as AudioEvent);
        break;
    }
  }
  close() {
    this.closed = true;
    this.turn = null;
    this.changed();
  }
}
