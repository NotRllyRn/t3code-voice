// @effect-diagnostics globalTimers:off - The injected browser lifecycle is independent of an Effect runtime.
import {
  decodeLiveVoiceClientEvent,
  decodeLiveVoiceServerEvent,
  LIVE_VOICE_CONNECT_BUDGET_MS,
  LIVE_VOICE_CREATE_TIMEOUT_MS,
  LIVE_VOICE_HEARTBEAT_INTERVAL_MS,
  LIVE_VOICE_MAX_CREATE_ATTEMPTS,
  LIVE_VOICE_MAX_FRAME_BYTES,
  LIVE_VOICE_STOP_TIMEOUT_MS,
  LiveVoiceStartupError,
  type LiveVoiceCleanupResult,
  type LiveVoiceClientEvent,
  type LiveVoicePhase,
  type LiveVoiceReason,
  type LiveVoiceServerEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { VoiceSocket } from "./media.ts";
import type { LiveMedia, LiveMediaFactory } from "./liveMedia.ts";

const isStartupError = Schema.is(LiveVoiceStartupError);

export interface LiveVoiceState {
  phase: LiveVoicePhase;
  muted: boolean;
  error: string;
  cleanupResult?: LiveVoiceCleanupResult | undefined;
  reason?: LiveVoiceReason | undefined;
  sessionId?: string | undefined;
  threadId?: ThreadId | undefined;
  retryAt?: number | undefined;
  deadlineAt?: number | undefined;
}
export const INITIAL_LIVE_VOICE_STATE: LiveVoiceState = {
  phase: "idle",
  muted: false,
  error: "",
};

const reasons: Record<LiveVoiceReason, string> = {
  "environment-auth-required": "Reconnect to this T3 environment, then start voice again.",
  "auth-required":
    "Check the selected Codex provider’s credential in this environment, then try again.",
  forbidden: "Live voice is not allowed by this connection or provider.",
  quota: "The selected voice provider has no available quota.",
  "rate-limited": "The selected voice provider is rate limited. Try again later.",
  "unsupported-provider": "Live voice requires a supported configured Codex provider.",
  "unsupported-endpoint": "The selected provider does not support native Live voice.",
  "unsupported-model": "The selected provider does not support the requested Live model.",
  "incompatible-protocol": "The provider's Live protocol is not supported. Voice stopped safely.",
  "invalid-offer": "The voice media connection could not be negotiated.",
  "refresh-pending":
    "Waiting for the selected provider to refresh. You can stop voice at any time.",
  "temporarily-unavailable": "Live voice is temporarily unavailable. Try again.",
  timeout: "Live voice did not connect in time. Try again.",
  "connection-changed": "The voice connection changed. Start voice again.",
  "media-denied": "Microphone access failed. Check microphone permission and try again.",
  "playback-blocked": "Voice playback was blocked. Allow audio playback and start voice again.",
  disconnected: "Live voice disconnected. Start voice again.",
};

interface Attempt {
  id: string;
  abort: AbortController;
  finalizers: Array<() => void>;
  media?: LiveMedia;
  ready: boolean;
  answerPending: boolean;
  answered: boolean;
  activating: boolean;
  active: boolean;
  sent: boolean;
}
interface Session {
  abort: AbortController;
  socket?: VoiceSocket;
  sessionId?: string;
  attempts: Set<string>;
  attempt?: Attempt | undefined;
  finalizers: Array<() => void>;
  connected: boolean;
  stopping: boolean;
  stopReason?: LiveVoiceReason | undefined;
  hadCall: boolean;
}
export interface LiveVoiceDependencies {
  media: LiveMediaFactory;
  socket(url: string): VoiceSocket;
  url(signal: AbortSignal): Promise<string>;
  event?(event: LiveVoiceServerEvent): void;
}

/** App-control only: the server authorizes each attempt; media never passes through this socket. */
export class LiveVoiceController {
  state: LiveVoiceState = { ...INITIAL_LIVE_VOICE_STATE };
  private session: Session | undefined;
  private disposed = false;
  private readonly deps: LiveVoiceDependencies;
  private readonly publish: (state: LiveVoiceState) => void;
  constructor(deps: LiveVoiceDependencies, publish: (state: LiveVoiceState) => void) {
    this.deps = deps;
    this.publish = publish;
  }
  private update(patch: Partial<LiveVoiceState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.publish(this.state);
  }
  private current(session: Session) {
    return this.session === session && !session.abort.signal.aborted;
  }
  private alive(session: Session, attempt?: Attempt) {
    return (
      !this.disposed &&
      this.current(session) &&
      !session.stopping &&
      (!attempt || (session.attempt === attempt && !attempt.abort.signal.aborted))
    );
  }
  private send(session: Session, event: LiveVoiceClientEvent) {
    const socket = session.socket;
    if (
      !this.current(session) ||
      !socket ||
      socket.readyState !== 1 ||
      socket.bufferedAmount > LIVE_VOICE_MAX_FRAME_BYTES
    )
      throw Error("Live control unavailable");
    const frame = JSON.stringify(event);
    decodeLiveVoiceClientEvent(frame);
    socket.send(frame);
  }
  private closeAttempt(session: Session) {
    const attempt = session.attempt;
    session.attempt = undefined;
    if (!attempt) return;
    attempt.abort.abort();
    for (const finalize of attempt.finalizers.splice(0).reverse()) {
      try {
        finalize();
      } catch {
        /* Continue releasing the remaining media resources. */
      }
    }
  }
  private finish(session: Session, result: LiveVoiceCleanupResult) {
    if (!this.current(session)) return;
    this.session = undefined;
    session.abort.abort();
    this.closeAttempt(session);
    for (const finalize of session.finalizers.splice(0).reverse()) {
      try {
        finalize();
      } catch {
        /* A failed finalizer must not retain other resources. */
      }
    }
    this.update({
      phase: session.stopReason ? "error" : "idle",
      error: session.stopReason
        ? reasons[session.stopReason]
        : result === "acknowledged" || !session.hadCall
          ? ""
          : "Voice stopped. Remote cleanup was not acknowledged.",
      reason: session.stopReason,
      cleanupResult: result,
      muted: false,
      retryAt: undefined,
      deadlineAt: undefined,
    });
  }
  private end(reason?: LiveVoiceReason, immediate = false) {
    const session = this.session;
    if (!session) return;
    if (session.stopping) {
      if (immediate) this.finish(session, "unknown");
      return;
    }
    session.stopping = true;
    session.stopReason = reason;
    try {
      session.attempt?.media?.stopAudio();
    } catch {
      immediate = true;
    }
    this.update({
      phase: "stopping",
      muted: true,
      reason,
      retryAt: undefined,
      deadlineAt: undefined,
    });
    try {
      this.send(session, { type: "live.stop" });
    } catch {
      immediate = true;
    }
    if (!this.current(session)) return;
    if (immediate || !session.attempt?.sent) {
      this.finish(session, "unknown");
      return;
    }
    // A server answer settles create, even while the browser is still applying that answer.
    const wait =
      LIVE_VOICE_STOP_TIMEOUT_MS +
      (session.attempt.answerPending ? 0 : LIVE_VOICE_CREATE_TIMEOUT_MS);
    const deadline = setTimeout(() => this.finish(session, "unknown"), wait);
    session.finalizers.push(() => clearTimeout(deadline));
  }
  async start() {
    if (this.disposed || this.session) return;
    const session: Session = {
      abort: new AbortController(),
      attempts: new Set(),
      finalizers: [],
      connected: false,
      stopping: false,
      hadCall: false,
    };
    this.session = session;
    this.state = { ...INITIAL_LIVE_VOICE_STATE, phase: "connecting" };
    this.update({});
    const deadline = setTimeout(() => {
      if (this.alive(session) && !session.attempt?.active) this.end("timeout");
    }, LIVE_VOICE_CONNECT_BUDGET_MS);
    session.finalizers.push(() => clearTimeout(deadline));
    try {
      const url = await this.deps.url(session.abort.signal);
      if (!this.alive(session)) return;
      const socket = this.deps.socket(url);
      session.socket = socket;
      const message = ({ data }: { data: unknown }) => {
        if (!this.current(session)) return;
        try {
          if (typeof data !== "string") throw Error("Binary control");
          this.receive(session, decodeLiveVoiceServerEvent(data));
        } catch {
          this.end("incompatible-protocol");
        }
      };
      const disconnected = () => {
        if (this.current(session)) this.end("disconnected", true);
      };
      socket.addEventListener("message", message);
      socket.addEventListener("close", disconnected);
      socket.addEventListener("error", disconnected);
      session.finalizers.push(() => {
        socket.removeEventListener("message", message);
        socket.removeEventListener("close", disconnected);
        socket.removeEventListener("error", disconnected);
        socket.close();
      });
      const heartbeat = setInterval(() => {
        if (!this.alive(session) || socket.readyState !== 1) return;
        try {
          this.send(session, { type: "live.heartbeat" });
        } catch {
          this.end("disconnected");
        }
      }, LIVE_VOICE_HEARTBEAT_INTERVAL_MS);
      session.finalizers.push(() => clearInterval(heartbeat));
    } catch (error) {
      if (this.alive(session))
        this.end(isStartupError(error) ? error.reason : "temporarily-unavailable");
    }
  }
  private receive(session: Session, event: LiveVoiceServerEvent) {
    if ("sessionId" in event) {
      if (session.sessionId && event.sessionId !== session.sessionId) return;
      if (!session.sessionId) {
        if (event.type !== "live.status") throw Error("Missing authorization");
        session.sessionId = event.sessionId;
        if (event.phase === "connecting" && this.state.muted) {
          this.send(session, { type: "live.mute", muted: true });
        }
      }
    }
    if (event.type === "live.cleanup") {
      this.finish(session, event.result);
      this.deps.event?.(event);
      return;
    }
    if (session.stopping) return;
    // A retired peer cannot change the current attempt's state, even within the same session.
    if (
      event.type === "live.status" &&
      event.attemptId &&
      session.attempts.has(event.attemptId) &&
      event.attemptId !== session.attempt?.id
    )
      return;
    switch (event.type) {
      case "live.status": {
        if (session.connected && (event.phase === "connecting" || event.phase === "refresh_wait")) {
          if (
            event.phase === "connecting" &&
            (!event.attemptId || event.attemptId === session.attempt?.id)
          )
            break;
          throw Error("Unexpected reconnect");
        }
        this.update({ sessionId: event.sessionId });
        if (event.phase === "error") {
          this.end(event.reason ?? "temporarily-unavailable");
          break;
        }
        if (event.phase === "idle" || event.phase === "stopping") {
          this.end();
          break;
        }
        if (event.phase === "refresh_wait") {
          this.closeAttempt(session);
          this.update({
            phase: "refresh_wait",
            reason: event.reason,
            retryAt: event.retryAt,
            deadlineAt: event.deadlineAt,
          });
          break;
        }
        if (event.phase === "connecting") {
          this.update({
            phase: "connecting",
            reason: event.reason,
            retryAt: undefined,
            deadlineAt: event.deadlineAt,
          });
          if (event.attemptId && !session.attempts.has(event.attemptId)) {
            if (session.connected || session.attempts.size >= LIVE_VOICE_MAX_CREATE_ATTEMPTS)
              throw Error("Unexpected attempt");
            void this.createAttempt(session, event.attemptId);
          }
        } else if (event.phase === "connected") {
          if (!session.attempt || (event.attemptId && event.attemptId !== session.attempt.id))
            break;
          session.connected = true;
          void this.activate(session, session.attempt);
        }
        break;
      }
      case "live.answer": {
        const attempt = session.attempt;
        if (!attempt || attempt.id !== event.attemptId || !attempt.media || attempt.answerPending)
          break;
        attempt.answerPending = true;
        void attempt.media
          .answer(event.answerSdp)
          .then(() => {
            if (this.alive(session, attempt)) {
              attempt.answered = true;
              void this.activate(session, attempt);
            }
          })
          .catch(() => {
            if (this.alive(session, attempt)) this.end("invalid-offer");
          });
        break;
      }
      case "live.closed":
        this.end(event.reason);
        break;
      case "live.bound":
        this.update({ threadId: event.threadId });
        break;
      case "live.caption":
      case "live.agent":
        break;
    }
    this.deps.event?.(event);
  }
  private async createAttempt(session: Session, id: string) {
    this.closeAttempt(session);
    const attempt: Attempt = {
      id,
      abort: new AbortController(),
      finalizers: [],
      ready: false,
      answerPending: false,
      answered: false,
      activating: false,
      active: false,
      sent: false,
    };
    session.attempt = attempt;
    session.attempts.add(id);
    const own = (finalize: () => void) => {
      if (this.alive(session, attempt)) attempt.finalizers.push(finalize);
      else finalize();
    };
    try {
      const media = await this.deps.media({
        signal: attempt.abort.signal,
        alive: () => this.alive(session, attempt),
        own,
        fail: (reason) => {
          if (this.alive(session, attempt)) this.end(reason);
        },
        peer: (state) => {
          if (state === "failed" && this.current(session) && session.attempt === attempt) {
            if (session.stopping) this.closeAttempt(session);
            else this.end("disconnected", true);
            return;
          }
          if (!this.alive(session, attempt)) return;
          try {
            this.send(session, { type: "live.peer", attemptId: id, state });
            attempt.ready = true;
            void this.activate(session, attempt);
          } catch {
            this.end("disconnected");
          }
        },
      });
      own(() => media.dispose());
      if (!this.alive(session, attempt)) return;
      attempt.media = media;
      media.microphone(false);
      const offerSdp = await media.offer();
      if (!this.alive(session, attempt)) return;
      this.send(session, { type: "live.start", attemptId: id, offerSdp });
      attempt.sent = true;
      session.hadCall = true;
    } catch {
      if (this.alive(session, attempt)) this.end("media-denied");
    }
  }
  private async activate(session: Session, attempt: Attempt) {
    if (
      !this.alive(session, attempt) ||
      !session.connected ||
      !attempt.ready ||
      !attempt.answered ||
      !attempt.media ||
      attempt.activating
    )
      return;
    attempt.activating = true;
    try {
      await attempt.media.playback(true);
      if (this.alive(session, attempt) && session.connected) {
        attempt.active = true;
        attempt.media.microphone(!this.state.muted);
        this.update({ phase: "connected", reason: undefined, retryAt: undefined });
      }
    } catch {
      if (this.alive(session, attempt)) this.end("playback-blocked");
    }
  }
  mute() {
    const session = this.session;
    if (!session || session.stopping) return;
    const muted = !this.state.muted;
    this.update({ muted });
    session.attempt?.media?.microphone(
      this.state.phase === "connected" && session.attempt.ready && session.attempt.active && !muted,
    );
    if (!session.sessionId || !session.socket || session.socket.readyState === 0) return;
    try {
      this.send(session, { type: "live.mute", muted });
    } catch {
      this.end("disconnected");
    }
  }
  stop() {
    this.end();
  }
  dispose() {
    this.disposed = true;
    this.end();
  }
}
