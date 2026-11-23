// @effect-diagnostics globalDate:off - Recovery deadlines use the same browser clock as lifecycle timers.
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
  type LiveVoicePreferences,
  type LiveVoiceQuestionTarget,
  type LiveVoiceReason,
  type LiveVoiceServerEvent,
  ThreadId,
  type RunId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { VoiceSocket } from "./media.ts";
import type { LiveMedia, LiveMediaFactory } from "./liveMedia.ts";

const recoveryDelays = [2000, 5000, 10000, 20000] as const;
const recoverable = new Set<LiveVoiceReason>([
  "disconnected",
  "timeout",
  "temporarily-unavailable",
  "rate-limited",
  "refresh-pending",
]);

const isStartupError = Schema.is(LiveVoiceStartupError);

export interface LiveVoiceState {
  phase: LiveVoicePhase | "reconnecting";
  recoveryAttempt?: number | undefined;
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
  "unsupported-server": "This environment needs a compatible T3 Code Voice server.",
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
  "recovery-limit":
    "Voice recovery supports up to 32 pending tasks. Voice stopped; coding tasks continue in chat.",
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
  resolve?: MFunctionType;
  media: LiveMediaFactory;
  acquire?(signal: AbortSignal): Promise<(() => void) | null>;
  socket(url: string): VoiceSocket;
  url(signal: AbortSignal): Promise<string>;
  event?(event: LiveVoiceServerEvent): void;
}

/** App-control only: the server authorizes each attempt; media never passes through this socket. */
export class LiveVoiceController {
  state: LiveVoiceState = { ...INITIAL_LIVE_VOICE_STATE };
  private session: Session | undefined;
  private disposed = false;
  private releaseOwner: (() => void) | undefined;
  private readonly pendingMedia = new Set<Promise<LiveMedia>>();
  private releaseOwnership() {
    const release = this.releaseOwner;
    this.releaseOwner = undefined;
    if (!release) return;
    // getUserMedia cannot be cancelled; retain ownership until late tracks are disposed.
    if (this.pendingMedia.size) void Promise.allSettled(this.pendingMedia).then(release);
    else release();
  }
  private wantedMuted = false;
  private questionTarget: LiveVoiceQuestionTarget | null = null;
  private wantedNotifications: LiveVoicePreferences["notifications"] | undefined;
  private recoveryAttempt = 0;
  private recoveryDeadline = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingRuns = new Set<RunId>();
  private cancelRecovery() {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryAttempt = 0;
    this.recoveryDeadline = 0;
  }
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
    const reason = session.stopReason;
    if (!this.disposed && reason && recoverable.has(reason)) {
      if (!this.recoveryDeadline) this.recoveryDeadline = Date.now() + LIVE_VOICE_CONNECT_BUDGET_MS;
      const delay = recoveryDelays[this.recoveryAttempt];
      if (delay !== undefined && Date.now() + delay < this.recoveryDeadline) {
        this.recoveryAttempt++;
        this.update({
          phase: "reconnecting",
          error: "",
          reason,
          muted: this.wantedMuted,
          recoveryAttempt: this.recoveryAttempt,
          retryAt: Date.now() + delay,
          deadlineAt: this.recoveryDeadline,
          cleanupResult: result,
        });
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = undefined;
          void this.connect();
        }, delay);
        return;
      }
    }
    this.releaseOwnership();
    this.update({
      phase: session.stopReason ? "error" : "idle",
      error: session.stopReason
        ? (this.recoveryAttempt >= recoveryDelays.length
            ? "Live voice could not reconnect after 4 attempts. "
            : "") + reasons[session.stopReason]
        : result === "acknowledged" || !session.hadCall
          ? ""
          : (this.deps.resolve ?? mFallback)(
              msg("Voice stopped. Remote cleanup was not acknowledged."),
            ),
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
    const recovering =
      reason !== undefined &&
      recoverable.has(reason) &&
      this.recoveryAttempt < recoveryDelays.length;
    this.update({
      phase: recovering ? "reconnecting" : "stopping",
      recoveryAttempt: recovering ? this.recoveryAttempt + 1 : undefined,
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
    if (this.disposed || this.session || this.recoveryTimer !== undefined) return;
    this.cancelRecovery();
    this.pendingRuns.clear();
    this.wantedMuted = false;
    await this.connect();
  }
  private async connect() {
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
    this.state = {
      ...INITIAL_LIVE_VOICE_STATE,
      threadId: this.state.threadId,
      muted: this.wantedMuted,
      phase: this.recoveryAttempt ? "reconnecting" : "connecting",
      recoveryAttempt: this.recoveryAttempt,
    };
    this.update({});
    const deadline = setTimeout(
      () => {
        if (this.alive(session) && !session.attempt?.active) this.end("timeout");
      },
      this.recoveryDeadline
        ? Math.max(1, this.recoveryDeadline - Date.now())
        : LIVE_VOICE_CONNECT_BUDGET_MS,
    );
    session.finalizers.push(() => clearTimeout(deadline));
    try {
      if (!this.releaseOwner && this.deps.acquire) {
        const release = await this.deps.acquire(session.abort.signal);
        if (!this.alive(session)) {
          release?.();
          return;
        }
        if (!release) {
          this.end("forbidden", true);
          this.update({
            error: (this.deps.resolve ?? mFallback)(
              msg(
                "Live voice is running or finishing cleanup in this or another window. Try again after it stops.",
              ),
            ),
          });
          return;
        }
        this.releaseOwner = release;
      }
      const url = new URL(await this.deps.url(session.abort.signal));
      if (!this.alive(session)) return;
      const boundThread = this.state.threadId ?? url.searchParams.get("threadId");
      if (boundThread) this.update({ threadId: ThreadId.make(boundThread) });
      if (this.state.threadId) {
        url.searchParams.delete("draft");
        url.searchParams.set("threadId", this.state.threadId);
        if (this.pendingRuns.size)
          url.searchParams.set("resumeRunIds", JSON.stringify([...this.pendingRuns]));
      }
      const socket = this.deps.socket(url.toString());
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
        if (
          !session.stopping &&
          this.wantedNotifications !== undefined &&
          (event.phase === "connecting" || event.phase === "refresh_wait")
        ) {
          this.send(session, { type: "live.preferences", notifications: this.wantedNotifications });
        }
        if (
          this.questionTarget &&
          (event.phase === "connecting" || event.phase === "refresh_wait")
        ) {
          this.send(session, { type: "live.question", target: this.questionTarget });
        }
        if (event.phase === "connecting" && this.state.muted) {
          this.send(session, { type: "live.mute", muted: true });
        }
      }
    }
    if (event.type === "live.cleanup") {
      if (!session.stopping) session.stopReason = "disconnected";
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
            phase: this.recoveryAttempt ? "reconnecting" : "connecting",
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
        break;
      case "live.agent":
        if (event.runId) {
          if (event.status === "completed" || event.status === "failed")
            this.pendingRuns.delete(event.runId);
          else if (this.pendingRuns.has(event.runId) || this.pendingRuns.size < 32)
            this.pendingRuns.add(event.runId);
          else this.end("recovery-limit");
        }
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
      if (this.pendingMedia.size) {
        await Promise.allSettled(this.pendingMedia);
        if (!this.alive(session, attempt)) return;
      }
      const pending = this.deps.media({
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
      this.pendingMedia.add(pending);
      let media: LiveMedia;
      try {
        media = await pending;
      } finally {
        this.pendingMedia.delete(pending);
      }
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
        this.cancelRecovery();
        this.update({
          phase: "connected",
          reason: undefined,
          retryAt: undefined,
          recoveryAttempt: undefined,
          deadlineAt: undefined,
        });
      }
    } catch {
      if (this.alive(session, attempt)) this.end("playback-blocked");
    }
  }
  setQuestionTarget(target: LiveVoiceQuestionTarget | null) {
    if (this.disposed || this.questionTarget?.nonce === target?.nonce) return;
    this.questionTarget = target;
    const session = this.session;
    if (!session || !this.alive(session) || !session.sessionId) return;
    try {
      this.send(session, { type: "live.question", target });
    } catch {
      this.end("disconnected");
    }
  }
  setNotifications(notifications: LiveVoicePreferences["notifications"]) {
    if (this.disposed || this.wantedNotifications === notifications) return;
    this.wantedNotifications = notifications;
    const session = this.session;
    if (!session || !this.alive(session) || !session.sessionId) return;
    try {
      this.send(session, { type: "live.preferences", notifications });
    } catch {
      this.end("disconnected");
    }
  }
  mute() {
    const session = this.session;
    if (!session || session.stopping) return;
    const muted = !this.wantedMuted;
    this.wantedMuted = muted;
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
    this.cancelRecovery();
    this.pendingRuns.clear();
    if (this.session?.stopping) {
      this.session.stopReason = undefined;
      this.update({ phase: "stopping", recoveryAttempt: undefined });
    }
    if (this.session) this.end();
    else {
      this.releaseOwnership();
      this.update({ ...INITIAL_LIVE_VOICE_STATE });
    }
  }
  dispose() {
    this.disposed = true;
    this.stop();
  }
}
