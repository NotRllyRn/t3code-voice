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
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { readRealtimeVoiceConfig, realtimeVoiceRouteLayer } from "./route.ts";

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
      Effect.provide(secrets),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
    );
    expect(value).toEqual({
      url: config.T3CODE_REALTIME_URL,
      key: "fixture-only-secret",
      voice: "alloy",
      transcription: "whisper-1",
    });
  }),
);

test.live.each([{}, { ...config, T3CODE_REALTIME_URL: "https://invalid.example" }])(
  "constructs the actual route and fails closed on missing/invalid config",
  (variables) =>
    Effect.gen(function* () {
      const { handler, dispose } = HttpRouter.toWebHandler(
        realtimeVoiceRouteLayer.pipe(
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
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(variables))),
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
