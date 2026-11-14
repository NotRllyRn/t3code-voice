import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthOrchestrationOperateScope,
  REALTIME_VOICE_PATH,
  SecretReference,
  ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { boundedVoiceSocket, claimVoiceUpgrade, makeVoiceUpstream } from "./transport.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { sessionUpdate, upstreamUrl } from "./protocol.ts";
import { encodeVoiceFrame, relayVoiceSockets, VoiceRelayError } from "./relay.ts";

const decodeReference = Schema.decodeUnknownEffect(Schema.fromJsonString(SecretReference));
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);

// Config and secret references are server-owned. The browser cannot choose an upstream URL or key.
export const readRealtimeVoiceConfig = Effect.gen(function* () {
  const rawUrl = yield* Config.String("T3CODE_REALTIME_URL");
  const url = yield* Effect.try({
    try: () => upstreamUrl(rawUrl),
    catch: () => new VoiceRelayError(),
  });
  const reference = yield* decodeReference(yield* Config.String("T3CODE_REALTIME_SECRET_REF"));
  const key = yield* requireSettingsSecret(yield* SecretResolver.SecretResolver, reference);
  if (!key.trim() || /[\r\n]/.test(key)) return yield* Effect.fail(new VoiceRelayError());
  const voice = yield* Config.String("T3CODE_REALTIME_VOICE").pipe(Config.withDefault("alloy"));
  const transcription = yield* Config.String("T3CODE_REALTIME_TRANSCRIPTION_MODEL").pipe(
    Config.withDefault("whisper-1"),
  );
  return { url, key, voice, transcription };
});

export const realtimeVoiceRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // One socket per authenticated app session, not one per tab or thread.
    const active = new Set<string>();
    return HttpRouter.add(
      "GET",
      REALTIME_VOICE_PATH,
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
        const id = yield* decodeThreadId(query.get("threadId")).pipe(Effect.result);
        if (id._tag === "Failure") return HttpServerResponse.empty({ status: 400 });
        const thread = yield* threads.getThreadShell(id.success);
        if (!thread || thread.archivedAt || thread.deletedAt)
          return HttpServerResponse.empty({ status: 404 });
        const provider = yield* providers.getInstance(thread.modelSelection.instanceId);
        if (!provider?.enabled || provider.driverKind !== "codex")
          return HttpServerResponse.empty({ status: 403 });
        if (active.has(session.sessionId)) return HttpServerResponse.empty({ status: 409 });
        // Do not expose config/secret failures, even in the server logs. No fallback auth.
        const config = yield* readRealtimeVoiceConfig.pipe(Effect.result);
        if (config._tag === "Failure") return HttpServerResponse.empty({ status: 503 });
        return yield* Effect.gen(function* () {
          // Register cleanup before claiming, including on a cancelled HTTP upgrade.
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
          const downstream = boundedVoiceSocket(yield* request.upgrade, claim.wire);
          const toClient = yield* downstream.writer;
          const relay = Effect.gen(function* () {
            let wire: ReturnType<typeof makeVoiceUpstream> | undefined;
            const upstream = boundedVoiceSocket(
              yield* Socket.fromWebSocket(
                Effect.acquireRelease(
                  Effect.sync(() => {
                    wire = makeVoiceUpstream(config.success.url, config.success.key);
                    return wire;
                  }),
                  (ws) => Effect.sync(() => ws.terminate()),
                ),
                { openTimeout: "10 seconds", highWaterMark: 64 * 1024 },
              ),
              () => wire,
            );

            const initialModel = yield* encodeVoiceFrame(thread.modelSelection);
            const watchOwner = Effect.forever(
              Effect.gen(function* () {
                yield* Effect.sleep("2 seconds");
                const current = yield* threads.getThreadShell(thread.id);
                const instance = yield* providers.getInstance(thread.modelSelection.instanceId);
                if (
                  !current ||
                  current.archivedAt ||
                  current.deletedAt ||
                  (yield* encodeVoiceFrame(current.modelSelection)) !== initialModel ||
                  !instance?.enabled ||
                  instance.driverKind !== "codex"
                )
                  return yield* Effect.fail(new VoiceRelayError());
              }),
            );
            yield* relayVoiceSockets(
              downstream,
              upstream,
              sessionUpdate(config.success.voice, config.success.transcription),
              watchOwner,
            );
          });
          yield* relay.pipe(
            Effect.catchCause(() =>
              toClient
                .write(
                  '{"type":"relay.error","message":"Voice connection ended. Check server realtime configuration or start a new conversation."}',
                )
                .pipe(
                  Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
                  Effect.ignoreCause,
                ),
            ),
          );
          return HttpServerResponse.empty();
        }).pipe(Effect.scoped);
      }),
    );
  }),
);
