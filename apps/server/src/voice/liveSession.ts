import {
  LIVE_VOICE_CONNECT_BUDGET_MS,
  LIVE_VOICE_CREATE_TIMEOUT_MS,
  LIVE_VOICE_MAX_CREATE_ATTEMPTS,
  LIVE_VOICE_READY_TIMEOUT_MS,
  LIVE_VOICE_HEARTBEAT_TIMEOUT_MS,
  type LiveVoiceBinding,
  type LiveVoicePreferences,
  type LiveVoiceCleanupResult,
  type LiveVoiceCapability,
  type LiveVoiceServerEvent,
  decodeLiveVoiceClientEvent,
} from "@t3tools/contracts";
import {
  LiveConnectionError,
  type ResolvedLiveConnection,
} from "@t3tools/provider-core/server/liveConnection";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Socket from "effect/socket/Socket";
import { decodeNativeLiveEvent, encodeNativeLiveAppend } from "./liveProtocol.ts";
import { acquireLiveCall, liveRetryAt } from "./liveTransport.ts";
import { makeLiveAgentSession, type LiveResultOffer } from "./liveAgentSession.ts";

const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const unavailable = () => new LiveConnectionError({ reason: "disconnected" });
const decode = Schema.is(LiveConnectionError);
type LifecycleStage =
  | "app-stop"
  | "client-read"
  | "client-write"
  | "native-read"
  | "native-write"
  | "native-error"
  | "native-closed"
  | "native-decode"
  | "heartbeat-timeout"
  | "connect-timeout"
  | "ready-timeout"
  | "peer-failed"
  | "owner-validation"
  | "call-acquire"
  | "session-work"
  | "scope-release";
type Work =
  | { type: "client"; frame: string }
  | { type: "native"; frame: string }
  | { type: "tick" }
  | { type: "context" };

export const runLiveSession = Effect.fn("LiveSession.run")(function* (input: {
  readonly socket: Socket.Socket;
  readonly binding: LiveVoiceBinding;
  readonly preferences?: LiveVoicePreferences;
  readonly connection: ResolvedLiveConnection;
  readonly capability: LiveVoiceCapability;
  readonly modelSelection?: import("@t3tools/contracts").ModelSelection;
  readonly validateOwner: Effect.Effect<void, LiveConnectionError>;
  readonly onStopped?: () => void;
  readonly resultOffers?: Map<string, LiveResultOffer>;
  readonly taskEvents?: Stream.Stream<unknown, unknown>;
  readonly onBound: (id: import("@t3tools/contracts").ThreadId) => void;
}) {
  const sessionId = SecureRandom.uuidV4Unsafe();
  const queue = yield* Queue.bounded<Work>(128);
  const stop = yield* Deferred.make<void>();
  const resources = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(resources, Exit.void));
  let cleanup: { result: LiveVoiceCleanupResult } = { result: "unknown" };
  const writer = yield* input.socket.writer;
  let alive = true;
  let attempts = 0;
  let attemptId = SecureRandom.uuidV4Unsafe();
  let awaitingOffer = true;
  let previousOffer: string | undefined;
  const deadline = (yield* Clock.currentTimeMillis) + LIVE_VOICE_CONNECT_BUDGET_MS;
  let retryAt: number | undefined;
  let nativeStarted = false;
  let peer = false;
  let answerAt: number | undefined;
  let lastHeartbeat = yield* Clock.currentTimeMillis;
  let lastOwnerCheck = lastHeartbeat;
  let nativeWriter: Socket.Writer | undefined;
  let terminal:
    | { failureStage: LifecycleStage; initiator: "local" | "upstream" | "unknown" }
    | undefined;
  const diagnose = (failureStage: LifecycleStage, initiator: "local" | "upstream" | "unknown") =>
    Effect.sync(() => {
      terminal ??= { failureStage, initiator };
    });
  const validateOwner = input.validateOwner.pipe(
    Effect.tapError(() => diagnose("owner-validation", "local")),
  );
  const send = (event: LiveVoiceServerEvent) =>
    alive
      ? writer.write(stringify(event)).pipe(
          Effect.tapError(() => diagnose("client-write", "unknown")),
          Effect.mapError(unavailable),
        )
      : Effect.void;
  const status = (phase: "connecting" | "connected" | "refresh_wait") =>
    send({
      type: "live.status",
      sessionId,
      phase,
      ...(attemptId ? { attemptId } : {}),
      ...(deadline !== undefined ? { deadlineAt: deadline } : {}),
      ...(retryAt !== undefined ? { retryAt } : {}),
      ...(phase === "refresh_wait" ? { reason: "refresh-pending" as const } : {}),
      capability: input.capability,
    });
  const agent = yield* makeLiveAgentSession({
    binding: input.binding,
    canAnnounce: () => peer && nativeStarted && alive,
    ...(input.resultOffers ? { resultOffers: input.resultOffers } : {}),
    ...(input.preferences ? { preferences: input.preferences } : {}),
    sessionId,
    ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
    validateOwner,
    send,
    onBound: input.onBound,
    append: Effect.fn("LiveSession.append")(function* (event) {
      if (!nativeWriter || !alive) return;
      for (const message of encodeNativeLiveAppend(event)) {
        if (!alive) return;
        yield* nativeWriter.write(stringify(message)).pipe(
          Effect.tapError(() => diagnose("native-write", "unknown")),
          Effect.mapError(unavailable),
        );
      }
    }),
  }).pipe(Effect.provideService(Scope.Scope, resources));
  let contextQueued = false;
  const offer = (work: Work) => Queue.offer(queue, work).pipe(Effect.asVoid);
  if (input.taskEvents)
    yield* input.taskEvents.pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          if (!alive || contextQueued) return;
          contextQueued = true;
          yield* offer({ type: "context" });
        }),
      ),
      Effect.catchCause(() =>
        Effect.logWarning("Live task context stream ended; polling continues."),
      ),
      Effect.forkScoped,
      Effect.provideService(Scope.Scope, resources),
    );
  const downstreamReader = yield* input.socket.reader;
  const read = Effect.forever(
    downstreamReader.pull.pipe(
      Effect.flatMap((frames) =>
        Effect.forEach(
          frames,
          (frame) =>
            Effect.gen(function* () {
              if (typeof frame !== "string") return yield* unavailable();
              const event = yield* Effect.try({
                try: () => decodeLiveVoiceClientEvent(frame),
                catch: unavailable,
              });
              lastHeartbeat = yield* Clock.currentTimeMillis;
              if (event.type === "live.stop") {
                yield* diagnose("app-stop", "local");
                alive = false;
                yield* agent.stop;
                yield* Deferred.succeed(stop, undefined);
              } else yield* offer({ type: "client", frame });
            }),
          { discard: true },
        ),
      ),
    ),
  ).pipe(
    Effect.tapError(() => diagnose("client-read", "unknown")),
    Effect.mapError(unavailable),
  );
  const process = Effect.forever(
    Effect.gen(function* () {
      const work = yield* Queue.take(queue);
      if (!alive) return;
      const now = yield* Clock.currentTimeMillis;
      if (work.type === "context") {
        contextQueued = false;
        if (nativeStarted) yield* agent.poll;
        return;
      }
      if (work.type === "tick") {
        if (now - lastHeartbeat > LIVE_VOICE_HEARTBEAT_TIMEOUT_MS) {
          yield* diagnose("heartbeat-timeout", "local");
          return yield* unavailable();
        }
        if (now - lastOwnerCheck >= 5000) {
          lastOwnerCheck = now;
          yield* validateOwner;
        }
        if (deadline !== undefined && !(nativeStarted && peer) && now >= deadline) {
          yield* diagnose("connect-timeout", "local");
          return yield* new LiveConnectionError({ reason: "timeout" });
        }
        if (
          answerAt !== undefined &&
          !(nativeStarted && peer) &&
          now - answerAt >= LIVE_VOICE_READY_TIMEOUT_MS
        ) {
          yield* diagnose("ready-timeout", "local");
          return yield* new LiveConnectionError({ reason: "timeout" });
        }
        if (retryAt !== undefined && now >= retryAt) {
          yield* validateOwner;
          retryAt = undefined;
          attemptId = SecureRandom.uuidV4Unsafe();
          awaitingOffer = true;
          yield* status("connecting");
        }
        if (nativeStarted) yield* agent.poll;
        return;
      }
      if (work.type === "native") {
        const event = yield* Effect.try({
          try: () => decodeNativeLiveEvent(work.frame),
          catch: () => new LiveConnectionError({ reason: "incompatible-protocol" }),
        }).pipe(Effect.tapError(() => diagnose("native-decode", "upstream")));
        if (!event) return;
        if (event.type === "started") {
          if ("draft" in input.binding) yield* agent.bind;
          if (!alive) return;
          nativeStarted = true;
          yield* agent.seed;
          if (peer) yield* status("connected");
          yield* agent.poll;
        } else if (event.type === "error" || event.type === "closed") {
          yield* diagnose(event.type === "error" ? "native-error" : "native-closed", "upstream");
          return yield* unavailable();
        } else if (nativeStarted) yield* agent.receive(event);
        return;
      }
      const event = decodeLiveVoiceClientEvent(work.frame);
      if (event.type === "live.peer") {
        if (event.attemptId !== attemptId || answerAt === undefined) return;
        if (event.state === "failed") {
          yield* diagnose("peer-failed", "local");
          return yield* unavailable();
        }
        peer = true;
        if (nativeStarted) {
          yield* status("connected");
          yield* agent.poll;
        }
        return;
      }
      if (event.type === "live.mute") {
        yield* agent.setMuted(event.muted);
        return;
      }
      if (event.type === "live.question") {
        yield* agent.setQuestionTarget(event.target);
        return;
      }
      if (event.type === "live.preferences") {
        yield* agent.setNotifications(event.notifications);
        return;
      }
      if (event.type !== "live.start") return;
      if (
        !awaitingOffer ||
        attempts >= LIVE_VOICE_MAX_CREATE_ATTEMPTS ||
        retryAt !== undefined ||
        event.attemptId !== attemptId ||
        event.offerSdp === previousOffer
      )
        return yield* new LiveConnectionError({ reason: "invalid-offer" });
      if (now + LIVE_VOICE_CREATE_TIMEOUT_MS + LIVE_VOICE_READY_TIMEOUT_MS > deadline)
        return yield* new LiveConnectionError({ reason: "timeout" });
      yield* validateOwner;
      awaitingOffer = false;
      attempts++;
      previousOffer = event.offerSdp;
      yield* status("connecting");
      const callScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(callScope, Exit.void)).pipe(
        Effect.provideService(Scope.Scope, resources),
      );
      cleanup = { result: "unknown" };
      const initialContext = yield* agent.seed;
      if (!alive) return;
      const call = yield* acquireLiveCall(
        input.connection,
        event.offerSdp,
        cleanup,
        input.preferences,
        initialContext,
      ).pipe(
        Effect.provideService(Scope.Scope, callScope),
        Effect.tapError(() => diagnose("call-acquire", "unknown")),
      );
      if (!alive) return;
      if (call.type === "rejected") {
        yield* Scope.close(callScope, Exit.void);
        const next =
          call.refresh && attempts === 1
            ? liveRetryAt(yield* Clock.currentTimeMillis, deadline, call.retryAfter)
            : undefined;
        if (next === undefined) return yield* new LiveConnectionError({ reason: call.reason });
        retryAt = next;
        yield* status("refresh_wait");
        return;
      }
      const nativeReader = yield* call.socket.reader.pipe(
        Effect.provideService(Scope.Scope, callScope),
      );
      nativeWriter = yield* call.socket.writer.pipe(Effect.provideService(Scope.Scope, callScope));
      yield* Effect.forever(
        nativeReader.pull.pipe(
          Effect.flatMap((frames) =>
            Effect.forEach(
              frames,
              (frame) =>
                typeof frame === "string"
                  ? offer({ type: "native", frame })
                  : Effect.fail(unavailable()),
              { discard: true },
            ),
          ),
        ),
      ).pipe(
        Effect.tapError(() => diagnose("native-read", "unknown")),
        Effect.mapError(unavailable),
        Effect.catch(() =>
          send({ type: "live.status", sessionId, phase: "error", reason: "disconnected" }).pipe(
            Effect.ignore,
            Effect.andThen(Deferred.succeed(stop, undefined)),
          ),
        ),
        Effect.forkScoped,
        Effect.provideService(Scope.Scope, resources),
      );
      answerAt = yield* Clock.currentTimeMillis;
      yield* send({
        type: "live.answer",
        sessionId,
        attemptId: event.attemptId,
        answerSdp: call.answerSdp,
      });
    }),
  );
  yield* status("connecting");
  const tick = Effect.forever(
    Effect.sleep("1 second").pipe(Effect.andThen(offer({ type: "tick" }))),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      alive = false;
    }),
  );
  yield* Effect.all([process, read, tick], { concurrency: "unbounded", discard: true }).pipe(
    Effect.raceFirst(Deferred.await(stop)),
    Effect.tapError(() => diagnose("session-work", "unknown")),
    Effect.catch((error) =>
      send({
        type: "live.status",
        sessionId,
        phase: "error",
        reason: decode(error) ? error.reason : "disconnected",
      }),
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        yield* Effect.logInfo(
          "Live session ended",
          terminal ?? {
            failureStage: "scope-release",
            initiator: "local",
          },
        );
        alive = false;
        yield* agent.stop;
        yield* Scope.close(resources, Exit.void);
        input.onStopped?.();
        yield* writer
          .write(stringify({ type: "live.cleanup", sessionId, result: cleanup.result }))
          .pipe(Effect.timeout("1 second"), Effect.ignore);
      }),
    ),
  );
});
