import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthOrchestrationOperateScope,
  REALTIME_VOICE_PATH,
  SecretReference,
  ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
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
import { makeVoiceAgentSession, VoiceDraft } from "./agentSession.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";

const decodeReference = Schema.decodeUnknownEffect(Schema.fromJsonString(SecretReference));
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeDraft = Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceDraft), {
  onExcessProperty: "error",
});

// Only credential selection preserves empty values; other server config keeps its normal semantics.
export const RealtimeVoiceCredentialProvider = Context.Reference<ConfigProvider.ConfigProvider>(
  "t3/voice/RealtimeVoiceCredentialProvider",
  { defaultValue: () => ConfigProvider.fromEnv({ preserveEmptyStrings: true }) },
);

const readKeyFile = Effect.fn("voice.readKeyFile")(
  function* (filePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const userId = yield* HostProcess.UserId;
    if (!path.isAbsolute(filePath) || /[\x00-\x1f\x7f]/.test(filePath))
      return yield* new VoiceRelayError();
    const suitable = (info: FileSystem.File.Info) =>
      info.type === "File" &&
      info.size > 0n &&
      info.size <= 4096n &&
      (platform === "win32" ||
        (((info.mode & 0o7777) === 0o400 || (info.mode & 0o7777) === 0o600) &&
          Option.getOrUndefined(info.uid) === userId));
    // Check before open to reject devices/FIFOs, then check the opened regular file too.
    if (!suitable(yield* fs.stat(filePath))) return yield* new VoiceRelayError();
    const file = yield* fs.open(filePath, { flag: "r" });
    if (!suitable(yield* file.stat)) return yield* new VoiceRelayError();
    const bytes = new Uint8Array(4097);
    let length = 0;
    while (length < bytes.length) {
      const count = yield* file.read(bytes.subarray(length));
      if (count === 0) break;
      length += count;
    }
    if (length === 0 || length > 4096) return yield* new VoiceRelayError();
    return Redacted.make(
      new TextDecoder("utf-8", { ignoreBOM: true })
        .decode(bytes.subarray(0, length))
        .replace(/\r?\n$/, ""),
    );
  },
  Effect.scoped,
  Effect.mapError(() => new VoiceRelayError()),
);

// Config and secret references are server-owned. The browser cannot choose an upstream URL or key.
export const readRealtimeVoiceConfig = Effect.gen(function* () {
  const rawUrl = yield* Config.String("T3CODE_REALTIME_URL");
  const url = yield* Effect.try({
    try: () => upstreamUrl(rawUrl),
    catch: () => new VoiceRelayError(),
  });
  const credentialProvider = yield* RealtimeVoiceCredentialProvider;
  const obsoleteKey = yield* Config.Redacted("T3CODE_REALTIME_API_KEY")
    .pipe(Config.option)
    .parse(credentialProvider);
  if (Option.isSome(obsoleteKey)) return yield* new VoiceRelayError();
  const keyFile = yield* Config.String("T3CODE_REALTIME_API_KEY_FILE")
    .pipe(Config.option)
    .parse(credentialProvider);
  const reference = yield* Config.String("T3CODE_REALTIME_SECRET_REF")
    .pipe(Config.option)
    .parse(credentialProvider);
  if (Option.isSome(keyFile) === Option.isSome(reference)) return yield* new VoiceRelayError();
  const key = Option.isSome(keyFile)
    ? yield* readKeyFile(keyFile.value)
    : Redacted.make(
        yield* requireSettingsSecret(
          yield* SecretResolver.SecretResolver,
          yield* decodeReference(Option.getOrThrow(reference)),
        ),
      );
  if (!/^[\x21-\x7e]+$/.test(Redacted.value(key))) return yield* new VoiceRelayError();
  const voice = yield* Config.String("T3CODE_REALTIME_VOICE").pipe(Config.withDefault("alloy"));
  const transcription = yield* Config.String("T3CODE_REALTIME_TRANSCRIPTION_MODEL").pipe(
    Config.withDefault("whisper-1"),
  );
  return { url, key, voice, transcription };
}).pipe(Effect.mapError(() => new VoiceRelayError()));

export const realtimeVoiceRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
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
        const continuous = query.get("continuous") === "1";
        const id = yield* decodeThreadId(query.get("threadId")).pipe(Effect.result);
        const draft = yield* decodeDraft(query.get("draft")).pipe(Effect.result);
        if (id._tag === "Failure" && (!continuous || draft._tag === "Failure"))
          return HttpServerResponse.empty({ status: 400 });
        const thread =
          id._tag === "Success" ? yield* threads.getThreadShell(id.success) : undefined;
        if (id._tag === "Success" && (!thread || thread.archivedAt || thread.deletedAt))
          return HttpServerResponse.empty({ status: 404 });
        const draftValue = draft._tag === "Success" ? draft.success : undefined;
        const modelSelection = thread?.modelSelection ?? draftValue!.modelSelection;
        const provider = yield* providers.getInstance(modelSelection.instanceId);
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
                    wire = makeVoiceUpstream(
                      config.success.url,
                      Redacted.value(config.success.key),
                    );
                    return wire;
                  }),
                  (ws) => Effect.sync(() => ws.terminate()),
                ),
                { openTimeout: "10 seconds", highWaterMark: 64 * 1024 },
              ),
              () => wire,
            );

            let boundThreadId = thread?.id;
            const initialModel = yield* encodeVoiceFrame(modelSelection);
            const watchOwner = Effect.forever(
              Effect.gen(function* () {
                yield* Effect.sleep("2 seconds");
                const current = boundThreadId
                  ? yield* threads.getThreadShell(boundThreadId)
                  : undefined;
                const instance = yield* providers.getInstance(modelSelection.instanceId);
                if (
                  (boundThreadId &&
                    (!current ||
                      current.archivedAt ||
                      current.deletedAt ||
                      (yield* encodeVoiceFrame(current.modelSelection)) !== initialModel)) ||
                  !instance?.enabled ||
                  instance.driverKind !== "codex"
                )
                  return yield* new VoiceRelayError();
              }),
            );
            yield* relayVoiceSockets(
              downstream,
              upstream,
              sessionUpdate(config.success.voice, config.success.transcription, continuous),
              watchOwner,
              continuous
                ? (up, down) =>
                    makeVoiceAgentSession(
                      thread ? { threadId: thread.id } : { draft: draftValue! },
                      up,
                      (event) => {
                        const value = event as { type?: string; thread_id?: string };
                        if (value.type === "agent.bound" && value.thread_id)
                          boundThreadId = ThreadId.make(value.thread_id);
                        return down(event);
                      },
                    ).pipe(
                      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
                      Effect.provideService(ThreadLaunch.ThreadLaunchService, launches),
                      Effect.provideService(ManagedProjectFolders.ManagedProjectFolders, folders),
                    )
                : undefined,
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
