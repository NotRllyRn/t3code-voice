import type { RealtimeEvent } from "./conversation.ts";

type Text = { text: string; final: boolean; saved: boolean };

/** Provisional display only; canonical persistence belongs to the server owner. */
export class LiveTranscripts {
  private inputs = new Map<string, Text>();
  private replies = new Map<string, Text>();
  private currentInput = "";
  private currentReply = "";
  private entry(map: Map<string, Text>, id: string, limit: number) {
    let value = map.get(id);
    if (!value) {
      if (map.size >= limit) throw Error("Voice transcript limit reached");
      value = { text: "", final: false, saved: false };
      map.set(id, value);
    }
    return value;
  }
  input(event: RealtimeEvent) {
    if (!event.item_id) return;
    const fresh = !this.inputs.has(event.item_id);
    const value = this.entry(this.inputs, event.item_id, 64);
    if (fresh) this.currentInput = event.item_id;
    if (event.type === "agent.recorded") value.saved = true;
    else if (event.transcript !== undefined) {
      value.text = event.transcript.slice(0, 16000);
      value.final = true;
    } else if (!value.final && event.delta !== undefined) {
      if (value.text.length + event.delta.length > 16000)
        throw Error("Voice transcript limit reached");
      value.text += event.delta;
    }
    const current = this.inputs.get(this.currentInput)!;
    return {
      transcript: current.text,
      transcriptStatus: current.saved ? "saved" : current.final ? "saving" : "live",
    };
  }
  reply(event: RealtimeEvent) {
    if (!event.response_id || !event.item_id || !Number.isInteger(event.content_index)) return;
    const id = `${event.response_id}:${event.item_id}:${event.content_index}`;
    const fresh = !this.replies.has(id);
    const value = this.entry(this.replies, id, 192);
    if (fresh) this.currentReply = id;
    if (event.transcript !== undefined) {
      value.text = event.transcript.slice(0, 16000);
      value.final = true;
    } else if (!value.final && event.delta !== undefined) {
      if (value.text.length + event.delta.length > 16000)
        throw Error("Voice transcript limit reached");
      value.text += event.delta;
    }
    const current = this.replies.get(this.currentReply)!;
    return { reply: current.text, replyPartial: !current.final };
  }
}
