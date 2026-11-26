import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthOrchestrationOperateScope,
  LIVE_VOICE_PATH,
  LIVE_VOICE_PROTOCOL,
  LIVE_VOICE_REQUESTED_MODEL,
  LiveVoiceBinding,
  LiveVoiceResumeRunIds,
  LiveVoicePreferences,
  DEFAULT_LIVE_VOICE_PREFERENCES,
  type LiveVoiceReason,
  type ThreadId,
} from "@t3tools/contracts";
import { LiveConnectionError } from "@t3tools/provider-core/server/liveConnection";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { claimVoiceUpgrade, boundedVoiceSocket } from "./transport.ts";
import { VoiceOwners } from "./owner.ts";
import type { LiveResultOffer } from "./liveAgentSession.ts";
import { runLiveSession } from "./liveSession.ts";
import { liveNetworkLayer } from "./liveTransport.ts";

const decodePreferences = Schema.decodeUnknownEffect(Schema.fromJsonString(LiveVoicePreferences), {
  onExcessProperty: "error",
});
const decodeResume = Schema.decodeUnknownEffect(Schema.fromJsonString(LiveVoiceResumeRunIds));
const decodeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(LiveVoiceBinding), {
  onExcessProperty: "error",
});
const encodeSelection = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const changed = () => new LiveConnectionError({ reason: "connection-changed" });

// Only called after upgrade authentication, operate scope and binding validation.
const startupFailure = Effect.fn("LiveRoute.startupFailure")(
  function* (request: HttpServerRequest.HttpServerRequest, reason: LiveVoiceReason) {
    const claim = yield* Effect.acquireRelease(
      Effect.sync(() => claimVoiceUpgrade(NodeHttpServerRequest.toIncomingMessage(request).socket)),
      (claim) => Effect.sync(claim.close),
    );
    const socket = boundedVoiceSocket(yield* request.upgrade, claim.wire);
    yield* socket.reader;
    const writer = yield* socket.writer;
    const sessionId = SecureRandom.uuidV4Unsafe();
    yield* writer.write(
      encodeSelection({ type: "live.status", sessionId, phase: "error", reason }),
    );
    yield* writer.write(encodeSelection({ type: "live.cleanup", sessionId, result: "unknown" }));
    return HttpServerResponse.empty();
  },
  Effect.scoped,
  Effect.timeout("2 seconds"),
);

export const liveVoiceRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const environmentId = yield* identity.getEnvironmentId;
    const active = yield* VoiceOwners;
    const recovery = new Map<string, Map<string, LiveResultOffer>>();
    return HttpRouter.add(
      "GET",
      LIVE_VOICE_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authenticated = yield* auth
          .authenticateWebSocketUpgrade(request, "media")
          .pipe(Effect.result);
        if (authenticated._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
        const session = authenticated.success;
        if (!session.scopes.includes(AuthOrchestrationOperateScope))
          return HttpServerResponse.empty({ status: 403 });
        const query = new URL(request.url, "http://localhost").searchParams;
        if (
          query.getAll("threadId").length + query.getAll("draft").length !== 1 ||
          query.getAll("resumeRunIds").length > 1 ||
          query.getAll("preferences").length > 1 ||
          (query.get("preferences")?.length ?? 0) > 512 ||
          (query.has("resumeRunIds") &&
            (!query.has("threadId") ||
              new TextEncoder().encode(query.get("resumeRunIds") ?? "").byteLength > 8192)) ||
          [...query.keys()].some(
            (key) =>
              !["threadId", "draft", "wsTicket", "resumeRunIds", "preferences"].includes(key),
          )
        )
          return HttpServerResponse.empty({ status: 400 });
        const preferences = yield* decodePreferences(
          query.get("preferences") ?? encodeSelection(DEFAULT_LIVE_VOICE_PREFERENCES),
        ).pipe(Effect.result);
        if (preferences._tag === "Failure") return HttpServerResponse.empty({ status: 400 });
        const resume = yield* decodeResume(query.get("resumeRunIds") ?? "[]").pipe(Effect.result);
        if (resume._tag === "Failure") return HttpServerResponse.empty({ status: 400 });
        const rawBinding = query.has("threadId")
          ? encodeSelection({
              threadId: query.get("threadId"),
              ...(query.has("resumeRunIds") ? { resumeRunIds: resume.success } : {}),
            })
          : `{"draft":${query.get("draft")}}`;
        const decoded = yield* decodeBinding(rawBinding).pipe(Effect.result);
        if (decoded._tag === "Failure") return HttpServerResponse.empty({ status: 400 });
        const binding = decoded.success;
        let threadId: ThreadId | undefined = "threadId" in binding ? binding.threadId : undefined;
        const thread = threadId ? yield* threads.getThreadShell(threadId) : undefined;
        if (threadId && (!thread || thread.archivedAt || thread.deletedAt))
          return yield* startupFailure(request, "connection-changed");
        if ("threadId" in binding && binding.resumeRunIds?.length) {
          const requested = new Set(binding.resumeRunIds);
          const records = yield* threads.getThreadRecords(binding.threadId, ["runs"], {
            runIds: [...requested],
          });
          if (
            [...requested].some(
              (id) =>
                !records.runs.some((run) => run.id === id && run.threadId === binding.threadId),
            )
          )
            return HttpServerResponse.empty({ status: 400 });
        }
        const selection =
          thread?.modelSelection ?? ("draft" in binding ? binding.draft.modelSelection : undefined);
        if (!selection) return yield* startupFailure(request, "connection-changed");
        const codingProvider = yield* providers.getInstance(selection.instanceId);
        if (!codingProvider?.enabled) return yield* startupFailure(request, "unsupported-provider");
        if (active.has(session.sessionId))
          return yield* startupFailure(request, "temporarily-unavailable");
        const candidates = [
          codingProvider,
          ...(yield* providers.listInstances)
            .filter((provider) => provider.instanceId !== codingProvider.instanceId)
            .sort((a, b) =>
              a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0,
            ),
        ].filter(
          (provider) =>
            provider.enabled && provider.driverKind === "codex" && provider.liveConnection,
        );
        const errorRank = (reason: LiveVoiceReason) =>
          reason === "auth-required"
            ? 3
            : reason === "unsupported-endpoint"
              ? 2
              : reason === "unsupported-provider"
                ? 0
                : 1;
        const resolved = yield* Effect.gen(function* () {
          let bestError: LiveConnectionError | undefined;
          for (const voiceProvider of candidates) {
            if (!voiceProvider.liveConnection) continue;
            const result = yield* voiceProvider.liveConnection
              .resolveLiveConnection()
              .pipe(Effect.result);
            if (result._tag === "Success") return { voiceProvider, connection: result.success };
            if (!bestError || errorRank(result.failure.reason) > errorRank(bestError.reason)) {
              bestError = result.failure;
            }
          }
          return yield* bestError ?? new LiveConnectionError({ reason: "unsupported-provider" });
        }).pipe(Effect.result);
        if (resolved._tag === "Failure")
          return yield* startupFailure(request, resolved.failure.reason);
        const { voiceProvider, connection } = resolved.success;
        const selectionIdentity = encodeSelection(selection);
        const validateOwner = Effect.gen(function* () {
          // Upgrade tickets are one-shot; re-check their bound session, never consume the ticket again.
          const sessions = yield* auth.listSessions();
          const authorized = sessions.find(
            (candidate) => candidate.sessionId === session.sessionId,
          );
          if (
            !authorized ||
            !authorized.scopes.includes(AuthOrchestrationOperateScope) ||
            DateTime.toEpochMillis(authorized.expiresAt) <= (yield* Clock.currentTimeMillis)
          )
            return yield* changed();
          const current = threadId ? yield* threads.getThreadShell(threadId) : undefined;
          if (
            threadId &&
            (!current ||
              current.archivedAt ||
              current.deletedAt ||
              encodeSelection(current.modelSelection) !== selectionIdentity)
          )
            return yield* changed();
          const instance = yield* providers.getInstance(selection.instanceId);
          if (!instance?.enabled || instance !== codingProvider) return yield* changed();
          const voiceInstance = yield* providers.getInstance(voiceProvider.instanceId);
          if (
            !voiceInstance?.enabled ||
            voiceInstance !== voiceProvider ||
            !voiceInstance.liveConnection
          )
            return yield* changed();
          const next = yield* voiceInstance.liveConnection.resolveLiveConnection();
          if (next.revision !== connection.revision) return yield* changed();
        }).pipe(Effect.mapError(changed));
        return yield* Effect.gen(function* () {
          let claimed = false;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (claimed) active.delete(session.sessionId);
            }),
          );
          if (active.has(session.sessionId)) return HttpServerResponse.empty({ status: 409 });
          active.add(session.sessionId);
          claimed = true;
          const claim = yield* Effect.acquireRelease(
            Effect.sync(() =>
              claimVoiceUpgrade(NodeHttpServerRequest.toIncomingMessage(request).socket),
            ),
            (claim) => Effect.sync(claim.close),
          );
          const socket = boundedVoiceSocket(yield* request.upgrade, claim.wire);
          let resultOffers = recovery.get(session.sessionId);
          if (!resultOffers) {
            if (recovery.size >= 128) {
              const oldest = [...recovery.keys()].find((id) => !active.has(id));
              if (oldest !== undefined) recovery.delete(oldest);
            }
            resultOffers = new Map<string, LiveResultOffer>();
            if (recovery.size < 128) recovery.set(session.sessionId, resultOffers);
          }
          yield* runLiveSession({
            socket,
            binding,
            resultOffers,
            taskEvents: threads.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.threadId === threadId &&
                  ((event.type === "message.updated" && !event.payload.voice) ||
                    event.type === "run.updated" ||
                    event.type === "runtime-request.updated" ||
                    event.type === "turn-item.updated" ||
                    event.type === "provider-turn.updated"),
              ),
            ),
            preferences: preferences.success,
            connection,
            modelSelection: selection,
            validateOwner,
            capability: {
              environmentId,
              providerInstanceId: voiceProvider.instanceId,
              protocol: LIVE_VOICE_PROTOCOL,
              requestedModel: LIVE_VOICE_REQUESTED_MODEL,
              effectiveModel: null,
            },
            onStopped: () => {
              active.delete(session.sessionId);
              claimed = false;
            },
            onBound: (id) => {
              threadId = id;
            },
          }).pipe(
            Effect.provideService(ThreadManagement.ThreadManagementService, threads),
            Effect.provideService(ThreadLaunch.ThreadLaunchService, launches),
            Effect.provideService(ManagedProjectFolders.ManagedProjectFolders, folders),
            Effect.provide(liveNetworkLayer),
            Effect.catch(() =>
              Effect.logWarning("Live voice session ended", { reason: "disconnected" }),
            ),
          );
          return HttpServerResponse.empty();
        }).pipe(Effect.scoped);
      }),
    );
  }),
);
