// @effect-diagnostics-next-line nodeBuiltinImport:off -- Match the launcher's native path without adding a service dependency.
import * as NodePath from "node:path";
import { LIVE_VOICE_PROTOCOL, LIVE_VOICE_REQUESTED_MODEL } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  LiveConnectionError,
  type ResolvedLiveConnection,
  type LiveConnectionResolver,
} from "@t3tools/provider-core/server/liveConnection";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { CODEX_APP_SERVER_THREAD_UNLOAD_DELAY_SECS } from "./codexLaunchArgs.ts";

const decodeSessionUnload = Schema.decodeUnknownSync(
  Schema.Struct({ thread_unload_delay_secs: Schema.Unknown }),
);

const Source = Schema.Struct({
  name: Schema.Struct({
    type: Schema.String,
    file: Schema.optional(Schema.String),
    profile: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  version: Schema.String,
});
const Config = Schema.Struct({
  config: Schema.Struct({
    model_provider: Schema.String,
    model_providers: Schema.Record(Schema.String, Schema.Unknown),
    thread_unload_delay_secs: Schema.optional(Schema.Unknown),
  }),
  origins: Schema.Record(Schema.String, Source),
  layers: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.Struct({ type: Schema.String }),
          disabledReason: Schema.optional(Schema.NullOr(Schema.String)),
          config: Schema.optional(Schema.Unknown),
          version: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
});
// Codex 0.169 config/read emits null optionals, not the sparse TOML shape.
const Provider = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  base_url: Schema.String,
  wire_api: Schema.Literal("responses"),
  requires_openai_auth: Schema.Literal(false),
  supports_websockets: Schema.optional(Schema.NullOr(Schema.Boolean)),
  env_key: Schema.optional(Schema.NullOr(Schema.String)),
  env_key_instructions: Schema.optional(Schema.NullOr(Schema.String)),
  experimental_bearer_token: Schema.optional(Schema.NullOr(Schema.String)),
  supports_standalone_web_search: Schema.optional(Schema.NullOr(Schema.Boolean)),
  request_max_retries: Schema.optional(Schema.NullOr(Schema.Number)),
  stream_max_retries: Schema.optional(Schema.NullOr(Schema.Number)),
  stream_idle_timeout_ms: Schema.optional(Schema.NullOr(Schema.Number)),
  websocket_connect_timeout_ms: Schema.optional(Schema.NullOr(Schema.Number)),
  // Alternate auth, destinations, headers and query settings must remain inactive.
  auth: Schema.optional(Schema.Null),
  aws: Schema.optional(Schema.Null),
  gateway_oauth: Schema.optional(Schema.Null),
  credential_file: Schema.optional(Schema.Null),
  project_id: Schema.optional(Schema.Null),
  location: Schema.optional(Schema.Null),
  model_catalog_url: Schema.optional(Schema.Null),
  capabilities: Schema.optional(Schema.Null),
  http_headers: Schema.optional(Schema.Null),
  env_http_headers: Schema.optional(Schema.Null),
  query_params: Schema.optional(Schema.Null),
});
const isConnectionError = Schema.is(LiveConnectionError);
const decodeConfig = Schema.decodeUnknownSync(Config);
const decodeProvider = Schema.decodeUnknownSync(Provider, { onExcessProperty: "error" });

function codexLiveCreateUrl(base: string): string {
  const url = new URL(base);
  if (
    base.length > 2048 ||
    /[\s\\%?#]/.test(base) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(base) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^(?:\/[A-Za-z0-9_-]+)*\/v1\/?$/.test(url.pathname) ||
    ["api.openai.com", "chatgpt.com", "chat.openai.com"].includes(url.hostname.toLowerCase())
  )
    throw new LiveConnectionError({ reason: "unsupported-endpoint" });
  url.pathname = url.pathname.replace(/\/$/, "") + "/live";
  return url.href;
}

export const makeCodexLiveConnection = Effect.fn("CodexLiveConnection.make")(function* (input: {
  readonly homePath: string;
  readonly launchArgs: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly readConfig: Effect.Effect<Redacted.Redacted<unknown>, LiveConnectionError>;
}) {
  const owner = yield* Effect.sync(() => SecureRandom.uuidV4Unsafe());
  let generation = 0;
  let previous: Redacted.Redacted<string> | undefined;
  return {
    resolveLiveConnection: Effect.fn("CodexLiveConnection.resolveLiveConnection")(function* () {
      if (!input.homePath)
        return yield* new LiveConnectionError({ reason: "unsupported-provider" });
      const privateConfig = yield* input.readConfig;
      return yield* Effect.try({
        try: (): ResolvedLiveConnection => {
          const raw = Redacted.value(privateConfig);
          const config = decodeConfig(raw);
          const key = config.config.model_provider;
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || key === "openai")
            throw new LiveConnectionError({ reason: "unsupported-provider" });
          const sessionLayers =
            config.layers?.filter(
              (layer) => !layer.disabledReason && layer.name.type === "sessionFlags",
            ) ?? [];
          const sessionOrigins = Object.entries(config.origins).filter(
            ([, origin]) => origin.name.type === "sessionFlags",
          );
          const sessionLayer = sessionLayers[0];
          const expectedSession: Record<string, unknown> = {
            thread_unload_delay_secs: CODEX_APP_SERVER_THREAD_UNLOAD_DELAY_SECS,
          };
          const expectedOrigins = new Set(["thread_unload_delay_secs"]);
          const args = tokenizeCliArgs(input.launchArgs);
          if (input.launchArgs.trim() && args.length === 0)
            throw new LiveConnectionError({ reason: "unsupported-provider" });
          const marketplaceSource = NodePath.join(
            input.homePath,
            ".tmp",
            "bundled-marketplaces",
            "openai-bundled",
          );
          const marketplacePath = "marketplaces.openai-bundled.source";
          const hasOwnedMarketplace =
            args[0] === "-c" &&
            args[1] === `${marketplacePath}=${stableStringify(marketplaceSource)}`;
          if (hasOwnedMarketplace) {
            expectedSession.marketplaces = { "openai-bundled": { source: marketplaceSource } };
            expectedOrigins.add(marketplacePath);
          }
          const ownerArgs = hasOwnedMarketplace ? args.slice(2) : args;
          if (ownerArgs.length > 0) {
            const provider = decodeProvider(config.config.model_providers[key]);
            const destination = {
              name: provider.name,
              base_url: provider.base_url,
              wire_api: provider.wire_api,
              requires_openai_auth: provider.requires_openai_auth,
              supports_websockets: provider.supports_websockets,
            };
            const overrides = new Map<string, unknown>([
              ["model_provider", key],
              ...Object.entries(destination).map(([field, value]): [string, unknown] => [
                `model_providers.${key}.${field}`,
                value,
              ]),
            ]);
            if (ownerArgs.length !== overrides.size * 2)
              throw new LiveConnectionError({ reason: "unsupported-provider" });
            for (let index = 0; index < ownerArgs.length; index += 2) {
              const assignment = ownerArgs[index + 1] ?? "";
              const equals = assignment.indexOf("=");
              const path = assignment.slice(0, equals).trim();
              const value = assignment.slice(equals + 1).trim();
              const expected = overrides.get(path);
              // Match only scalar owner args; config/read remains authoritative for TOML semantics.
              const matches =
                typeof expected === "boolean"
                  ? value === String(expected)
                  : typeof expected === "string" &&
                    (value === stableStringify(expected) ||
                      (!expected.includes("'") && value === `'${expected}'`) ||
                      value === expected);
              if (ownerArgs[index] !== "-c" || equals < 1 || !matches || !overrides.delete(path))
                throw new LiveConnectionError({ reason: "unsupported-provider" });
              expectedOrigins.add(path);
            }
            expectedSession.model_provider = key;
            expectedSession.model_providers = { [key]: destination };
          }
          // A session layer is trusted only when every field and origin matches our actual argv.
          const ownedSessionFlags =
            sessionLayers.length === 1 &&
            !!sessionLayer?.version &&
            Object.is(
              decodeSessionUnload(sessionLayer.config).thread_unload_delay_secs,
              CODEX_APP_SERVER_THREAD_UNLOAD_DELAY_SECS,
            ) &&
            stableStringify(sessionLayer.config) === stableStringify(expectedSession) &&
            Object.is(
              config.config.thread_unload_delay_secs,
              CODEX_APP_SERVER_THREAD_UNLOAD_DELAY_SECS,
            ) &&
            sessionOrigins.length === expectedOrigins.size &&
            sessionOrigins.every(
              ([path, origin]) =>
                expectedOrigins.has(path) && origin.version === sessionLayer.version,
            );
          if (
            ((args.length > 0 || sessionOrigins.length > 0) && !ownedSessionFlags) ||
            config.layers?.some(
              (layer) =>
                !layer.disabledReason &&
                !["user", "system", "packagedDefaults"].includes(layer.name.type) &&
                !(layer.name.type === "sessionFlags" && ownedSessionFlags),
            )
          )
            throw new LiveConnectionError({ reason: "unsupported-provider" });
          const trusted = (path: string) => {
            const origin = config.origins[path];
            if (
              ownedSessionFlags &&
              expectedOrigins.has(path) &&
              origin?.name.type === "sessionFlags"
            )
              return true;
            return (
              origin?.name.type === "user" &&
              !origin.name.profile &&
              origin.name.file === input.homePath.replace(/[\\/]$/, "") + "/config.toml"
            );
          };
          if (!trusted("model_provider"))
            throw new LiveConnectionError({ reason: "unsupported-provider" });
          const paths = Object.keys(config.origins).filter(
            (path) =>
              path === "model_providers" ||
              path === `model_providers.${key}` ||
              path.startsWith(`model_providers.${key}.`),
          );
          if (!paths.length || paths.some((path) => !trusted(path)))
            throw new LiveConnectionError({ reason: "unsupported-provider" });
          const provider = decodeProvider(config.config.model_providers[key]);
          const createUrl = codexLiveCreateUrl(provider.base_url);
          const credential =
            provider.env_key == null
              ? provider.experimental_bearer_token
              : /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(provider.env_key)
                ? input.environment[provider.env_key]
                : undefined;
          if (!credential || credential.length > 4096 || !/^[\x21-\x7e]+$/.test(credential))
            throw new LiveConnectionError({ reason: "auth-required" });
          if (
            args.length > 0 &&
            ![
              "model_providers",
              `model_providers.${key}`,
              `model_providers.${key}.${provider.env_key == null ? "experimental_bearer_token" : "env_key"}`,
            ].some((path) => config.origins[path]?.name.type === "user" && trusted(path))
          )
            throw new LiveConnectionError({ reason: "unsupported-provider" });
          // Comparison stays private. Public revision is random owner + monotonic generation, not a secret digest.
          // config/read object order varies between app-server processes.
          const identity = stableStringify([raw, input.homePath, createUrl, credential]);
          if (!previous || Redacted.value(previous) !== identity) {
            previous = Redacted.make(identity);
            generation++;
          }
          return {
            createUrl,
            headers: Redacted.make({
              Authorization: `Bearer ${credential}`,
              "OpenAI-Alpha": "quicksilver=v2",
            }),
            revision: `${owner}:${generation}`,
            protocol: LIVE_VOICE_PROTOCOL,
            requestedModel: LIVE_VOICE_REQUESTED_MODEL,
          };
        },
        catch: (error) =>
          isConnectionError(error)
            ? error
            : new LiveConnectionError({ reason: "unsupported-provider" }),
      });
    }),
  } satisfies LiveConnectionResolver;
});
