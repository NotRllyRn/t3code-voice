import { Conversation, type RealtimeEvent } from "./conversation.ts";
import { deadline, Lifecycle, type VoiceLifetime } from "./lifecycle.js";
import type { pcmMedia, VoiceMedia } from "./media.js";

type SocketLike = Pick<
  WebSocket,
  "readyState" | "bufferedAmount" | "send" | "close" | "addEventListener" | "removeEventListener"
>;
export interface VoiceState {
  phase: string;
  error: string;
  recording: boolean;
  muted: boolean;
  busy: boolean;
  transcript: string;
  reply: string;
}
export const INITIAL_VOICE_STATE: VoiceState = {
  phase: "idle",
  error: "",
  recording: false,
  muted: false,
  busy: false,
  transcript: "",
  reply: "",
};
export interface VoiceDependencies {
  microphone: () => Promise<MediaStream>;
  media: typeof pcmMedia;
  socket: (url: string) => SocketLike;
  url: (signal: AbortSignal) => Promise<string>;
}

/** One application-owned voice identity; no coding session or tool execution lives here. */
export class VoiceController {
  state: VoiceState = { ...INITIAL_VOICE_STATE };
  private lifetime: Lifecycle;
  private media: VoiceMedia | null = null;
  private conversation: Conversation | null = null;
  private socket: SocketLike | null = null;
  private stream: MediaStream | null = null;
  private samples = 0;
  private inputTurn = 0;
  private inputCommits: number[] = [];
  private inputItems = new Map<string, number>();
  private captureTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(
    private deps: VoiceDependencies,
    private publish: (state: VoiceState) => void,
  ) {
    this.lifetime = new Lifecycle((phase, error) => this.update({ phase, error }));
  }
  private update(change: Partial<VoiceState>) {
    this.state = { ...this.state, ...change };
    if (!this.disposed) this.publish(this.state);
  }
  private alive(session: VoiceLifetime) {
    return !this.disposed && this.lifetime.alive(session);
  }
  private send(event: object) {
    if (!this.socket || this.socket.readyState !== 1 || this.socket.bufferedAmount > 64 * 1024)
      throw Error("Voice connection is stalled");
    this.socket.send(JSON.stringify(event));
  }
  async start() {
    if (this.disposed || this.lifetime.current) return;
    const session = this.lifetime.begin("conversation", "ws");
    this.inputTurn = 0;
    this.inputCommits = [];
    this.inputItems.clear();
    this.update({ recording: false, muted: false, busy: false, transcript: "", reply: "" });
    const own = (fn: () => unknown) => this.lifetime.own(session, fn);
    const fail = (message: string) => {
      if (this.alive(session)) void this.stop(message);
    };
    try {
      // Register late microphone grants before checking ownership, so Stop cannot leak tracks.
      const stream = await this.deps.microphone();
      own(() => stream.getTracks().forEach((track) => track.stop()));
      if (!this.alive(session)) return;
      this.stream = stream;
      for (const track of stream.getTracks()) {
        const ended = () => fail("Microphone disconnected");
        track.addEventListener("ended", ended);
        own(() => track.removeEventListener("ended", ended));
      }
      const media = await this.deps.media(stream, {
        own,
        alive: () => this.alive(session),
        fail,
        capture: (audio, samples) => {
          if (!this.alive(session) || !this.state.recording || this.state.muted) return;
          this.samples += samples;
          if (this.samples > 24_000 * 15) throw Error("Voice turn is too long");
          this.send({ type: "input_audio_buffer.append", audio });
        },
      });
      if (!this.alive(session)) return;
      this.media = media;
      const audioChanged = () => {
        if (media.context.state !== "running")
          fail("Audio focus was lost; start a new voice conversation");
      };
      media.context.addEventListener("statechange", audioChanged);
      own(() => media.context.removeEventListener("statechange", audioChanged));
      const url = await this.deps.url(session.controller.signal);
      if (!this.alive(session)) return;
      const socket = this.deps.socket(url);
      this.socket = socket;
      own(() => {
        socket.close();
      });
      let ready: () => void = () => {};
      let rejectReady: (error: Error) => void = () => {};
      const configured = new Promise<void>((resolve, reject) => {
        ready = resolve;
        rejectReady = reject;
      });
      this.conversation = new Conversation((event) => this.send(event), media, fail);
      own(() => this.conversation?.close());
      const message = (event: MessageEvent) => {
        if (!this.alive(session)) return;
        try {
          if (typeof event.data !== "string" || event.data.length > 128 * 1024)
            throw Error("Invalid voice message");
          const data = JSON.parse(event.data) as RealtimeEvent;
          if (data.type === "relay.ready") {
            ready();
            return;
          }
          this.conversation?.event(data);
          if (data.type === "input_audio_buffer.committed" && data.item_id) {
            const turn = this.inputCommits.shift();
            if (turn !== undefined) this.inputItems.set(data.item_id, turn);
          }
          if (
            data.type === "conversation.item.input_audio_transcription.completed" &&
            data.transcript &&
            data.item_id &&
            this.inputItems.get(data.item_id) === this.inputTurn
          )
            this.update({ transcript: data.transcript.slice(0, 16_000) });
          if (
            (data.type === "response.audio_transcript.done" ||
              data.type === "response.output_audio_transcript.done") &&
            data.transcript &&
            this.conversation?.accepts(data.response_id)
          )
            this.update({ reply: data.transcript.slice(0, 16_000) });
        } catch {
          fail("Invalid voice response; conversation stopped");
        }
      };
      const disconnected = () => {
        rejectReady(
          Error(
            "Voice is unavailable. Check the server realtime configuration and use a saved Codex thread.",
          ),
        );
        fail("Voice disconnected. Check server configuration or start again.");
      };
      socket.addEventListener("message", message);
      socket.addEventListener("close", disconnected);
      socket.addEventListener("error", disconnected);
      own(() => {
        rejectReady(Error("Stopped"));
        socket.removeEventListener("message", message);
        socket.removeEventListener("close", disconnected);
        socket.removeEventListener("error", disconnected);
      });
      await deadline(configured, 10_000, "Voice session did not become ready");
      if (this.alive(session)) this.lifetime.active(session);
    } catch {
      fail(
        "Could not start voice. Check microphone permission, the saved Codex thread and server realtime configuration.",
      );
    }
  }
  async record() {
    const session = this.lifetime.current;
    if (
      !session ||
      !this.alive(session) ||
      this.state.phase !== "active" ||
      this.state.muted ||
      this.state.busy ||
      this.state.recording
    )
      return;
    this.update({ busy: true });
    try {
      await this.conversation?.interrupt();
      if (!this.alive(session)) return;
      this.send({ type: "input_audio_buffer.clear" });
      this.samples = 0;
      this.inputTurn++;
      this.update({ recording: true, transcript: "", reply: "" });
      this.media?.capture(true);
      // A bounded push-to-talk turn, not an always-listening microphone.
      this.captureTimer = setTimeout(() => {
        void this.finish();
      }, 14_000);
    } catch {
      if (this.alive(session)) await this.stop("Could not start a voice turn");
    } finally {
      if (this.alive(session)) this.update({ busy: false });
    }
  }
  async finish() {
    const session = this.lifetime.current;
    if (!session || !this.alive(session) || !this.state.recording || this.state.busy) return;
    clearTimeout(this.captureTimer);
    this.update({ busy: true });
    try {
      await this.media?.finishCapture();
      if (!this.alive(session)) return;
      this.update({ recording: false });
      if (this.samples >= 2400) {
        this.inputCommits.push(this.inputTurn);
        this.send({ type: "input_audio_buffer.commit" });
        this.conversation?.createResponse();
      } else this.send({ type: "input_audio_buffer.clear" });
    } catch {
      if (this.alive(session)) await this.stop("Could not finish the voice turn");
    } finally {
      if (this.alive(session)) this.update({ busy: false });
    }
  }
  async mute() {
    const session = this.lifetime.current;
    if (!session || !this.alive(session) || this.state.phase !== "active" || this.state.busy)
      return;
    const muted = !this.state.muted,
      wasRecording = this.state.recording;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    this.update({ muted, recording: muted ? false : wasRecording });
    if (muted && wasRecording) {
      clearTimeout(this.captureTimer);
      this.update({ busy: true });
      try {
        // Consume/discard queued capture before a later unmute/new turn can upload it.
        await this.media?.finishCapture();
        if (this.alive(session)) this.send({ type: "input_audio_buffer.clear" });
      } catch {
        if (this.alive(session)) await this.stop("Could not mute voice safely");
      } finally {
        if (this.alive(session)) this.update({ busy: false });
      }
    }
  }
  async interrupt() {
    const session = this.lifetime.current;
    if (!session || !this.alive(session) || this.state.busy) return;
    this.update({ busy: true });
    try {
      await this.conversation?.interrupt();
    } catch {
      if (this.alive(session)) await this.stop("Voice interruption failed");
    } finally {
      if (this.alive(session)) this.update({ busy: false });
    }
  }
  async stop(error = "") {
    clearTimeout(this.captureTimer);
    // Silence synchronously; cleanup promises must not prolong local playback or microphone use.
    this.stream?.getTracks().forEach((track) => {
      track.enabled = false;
    });
    void this.media?.silence().catch(() => {});
    this.conversation?.close();
    this.update({ recording: false, busy: false });
    await this.lifetime.stop(error);
    this.media = null;
    this.conversation = null;
    this.socket = null;
    this.stream = null;
  }
  dispose() {
    this.disposed = true;
    void this.stop();
  }
}
