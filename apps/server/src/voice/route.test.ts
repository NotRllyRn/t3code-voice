import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it as test } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  REALTIME_VOICE_PATH,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import {
  readRealtimeVoiceConfig,
  realtimeVoiceRouteLayer,
  RealtimeVoiceCredentialProvider,
} from "./route.ts";

const configuration = (env: Record<string, string>) =>
  Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    Layer.succeed(
      RealtimeVoiceCredentialProvider,
      ConfigProvider.fromEnv({ env, preserveEmptyStrings: true }),
    ),
  );

const reference = { provider: "fixture", reference: "fixture/key" };
const config = {
  T3CODE_REALTIME_URL: "wss://voice.example.invalid/v1/realtime?model=fixture",
  T3CODE_REALTIME_SECRET_REF: JSON.stringify(reference),
};
const secrets = Layer.mock(SecretResolver.SecretResolver)({
  read: (references) =>
    Effect.sync(() => {
      expect(references).toEqual([reference]);
      return ["fixture-only-secret"];
    }),
});

test.effect("executes actual Effect 4 configuration, secret-reference decoding and defaults", () =>
  Effect.gen(function* () {
    const value = yield* readRealtimeVoiceConfig.pipe(
      Effect.provide(Layer.mergeAll(secrets, configuration(config))),
    );
    expect(Redacted.value(value.key)).toBe("fixture-only-secret");
    expect(JSON.stringify(value)).not.toContain("fixture-only-secret");
    expect(value).toEqual({
      url: config.T3CODE_REALTIME_URL,
      key: Redacted.make("fixture-only-secret"),
      voice: "alloy",
      transcription: "whisper-1",
    });
  }),
);

test.effect("reads a bounded redacted server key file without a secret provider", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const file = path.join(directory, "voice-key");
    yield* fs.writeFileString(file, "fictional-file-only-key\r\n", { mode: 0o600 });
    const value = yield* readRealtimeVoiceConfig.pipe(
      Effect.provide(
        Layer.mergeAll(
          secrets,
          configuration({
            T3CODE_REALTIME_URL: config.T3CODE_REALTIME_URL,
            T3CODE_REALTIME_API_KEY_FILE: file,
            T3CODE_REALTIME_VOICE: "",
            T3CODE_REALTIME_TRANSCRIPTION_MODEL: "",
          }),
        ),
      ),
    );
    expect(Redacted.value(value.key)).toBe("fictional-file-only-key");
    expect(JSON.stringify(value)).not.toContain("fictional-file-only-key");
    expect(value.voice).toBe("alloy");
    expect(value.transcription).toBe("whisper-1");
  }).pipe(Effect.provide(NodeServices.layer)),
);

test.effect.each(["stat", "open", "read"])(
  "sanitizes file %s failures without retaining a cause",
  (stage) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = path.join(directory, "fictional-private-path");
      yield* fs.writeFileString(file, "fictional-key", { mode: 0o600 });
      const failure = Effect.fail(
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: stage,
          pathOrDescriptor: file,
          description: "fictional-key must not appear in errors",
        }),
      );
      const error = yield* readRealtimeVoiceConfig.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: stage === "stat" ? () => failure : fs.stat,
          open: (name, options) =>
            stage === "open"
              ? failure
              : fs
                  .open(name, options)
                  .pipe(
                    Effect.map((handle) =>
                      stage === "read"
                        ? { ...handle, stat: handle.stat, read: () => failure }
                        : handle,
                    ),
                  ),
        }),
        Effect.provide(
          configuration({
            T3CODE_REALTIME_URL: config.T3CODE_REALTIME_URL,
            T3CODE_REALTIME_API_KEY_FILE: file,
          }),
        ),
        Effect.flip,
      );
      expect(JSON.stringify(error)).toBe('{"_tag":"VoiceRelayError"}');
      expect(String(error)).not.toContain("fictional");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, secrets))),
);

const invalidConfigs = [
  {},
  { T3CODE_REALTIME_URL: config.T3CODE_REALTIME_URL },
  {
    T3CODE_REALTIME_URL: config.T3CODE_REALTIME_URL,
    T3CODE_REALTIME_API_KEY: "fictional-obsolete-key",
  },
  { ...config, T3CODE_REALTIME_URL: "https://invalid.example" },
  ...["", "/fictional/key"].flatMap((file) =>
    [config.T3CODE_REALTIME_SECRET_REF, ""].map((ref) => ({
      ...config,
      T3CODE_REALTIME_API_KEY_FILE: file,
      T3CODE_REALTIME_SECRET_REF: ref,
    })),
  ),
  { ...config, T3CODE_REALTIME_API_KEY: "fictional-ambiguous-key" },
  { ...config, T3CODE_REALTIME_API_KEY: " " },
  { ...config, T3CODE_REALTIME_API_KEY: "" },
  {
    ...config,
    T3CODE_REALTIME_API_KEY: "fictional-env-only-key",
    T3CODE_REALTIME_SECRET_REF: "",
  },
  { ...config, T3CODE_REALTIME_SECRET_REF: "invalid-fictional-reference" },
  ...["", "  ", "fictional\r\nInjected: header"].map((key) => ({
    T3CODE_REALTIME_URL: config.T3CODE_REALTIME_URL,
    T3CODE_REALTIME_API_KEY: key,
  })),
  ...[
    "ws://192.0.2.1/v1/realtime",
    "wss://user:fictional-url-password@voice.example/v1/realtime",
    "wss://voice.example/v1/realtime#fragment",
  ].map((url) => ({ T3CODE_REALTIME_URL: url, T3CODE_REALTIME_API_KEY: "fictional-key" })),
];

test.effect.each(invalidConfigs)("sanitizes configuration failures %#", (variables) =>
  Effect.gen(function* () {
    let secretReads = 0;
    const error = yield* readRealtimeVoiceConfig.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(SecretResolver.SecretResolver)({
            read: () =>
              Effect.sync(() => {
                secretReads++;
                return ["fixture-only-secret"];
              }),
          }),
          configuration(variables),
        ),
      ),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...(yield* FileSystem.FileSystem),
          stat: () => Effect.die("Invalid source selection must not access a file"),
        }),
      ),
      Effect.flip,
    );
    expect(secretReads).toBe(0);
    expect(error._tag).toBe("VoiceRelayError");
    expect(JSON.stringify(error)).toBe('{"_tag":"VoiceRelayError"}');
    expect(String(error)).not.toContain("fictional");
  }).pipe(Effect.provide(NodeServices.layer)),
);

test.live.each(invalidConfigs)(
  "constructs the actual route and fails closed on missing/invalid config",
  (variables) =>
    Effect.gen(function* () {
      const { handler, dispose } = HttpRouter.toWebHandler(
        realtimeVoiceRouteLayer.pipe(
          Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
          Layer.provide(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/fixture/projects",
            }),
          ),
          Layer.provide(
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              authenticateWebSocketUpgrade: () =>
                Effect.succeed({
                  sessionId: AuthSessionId.make("voice-test"),
                  subject: "fixture",
                  method: "bearer-access-token",
                  scopes: [AuthOrchestrationOperateScope],
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
            }),
          ),
          Layer.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              // Route-only fixture: no driver starts and no live credentials or network are used.
              getInstance: () =>
                Effect.succeed({ enabled: true, driverKind: "codex" } as ProviderInstance),
            }),
          ),
          Layer.provideMerge(secrets),
          Layer.provideMerge(configuration(variables)),
        ),
        { disableLogger: true },
      );
      try {
        const response = yield* Effect.promise(() =>
          handler(
            new Request(
              `http://localhost${REALTIME_VOICE_PATH}?threadId=${ThreadId.make("thread-voice")}`,
            ),
          ),
        );
        expect(response.status).toBe(503);
        expect(yield* Effect.promise(() => response.text())).toBe("");
      } finally {
        yield* Effect.promise(dispose);
      }
    }),
);
