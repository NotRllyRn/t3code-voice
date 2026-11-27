// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as CodexManagedTokenBroker from "../CodexManagedTokenBroker.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { CodexDriver } from "./CodexDriver.ts";

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-codex-driver-voice-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(PortScanner.layerTest),
  Layer.provideMerge(
    Layer.mock(CodexAdapterV2.CodexAppServerClientFactory)({
      open: () => Effect.die("Probe must not open a Codex session"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "unused-managed-installation",
    }),
  ),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
      endpoint: Effect.succeed("unused-private-pipe"),
      awaitIdle: Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Codex must not make an HTTP request")),
    ),
  ),
);
const layerTest = ProviderHostLive.layer.pipe(Layer.provideMerge(layerDeps));

it.layer(layerTest)("CodexDriver Voice", (it) => {
  it.effect(
    "probes again when Codex credentials or config.toml change and tracks liveVoiceAvailable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const codexHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-voice-watch-" });
        const watchedPath = yield* Deferred.make<string>();
        const homeEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-voice-watch"),
          displayName: "Codex voice watch",
          enabled: true,
          environment: [],
          config: { ...CodexDriver.defaultConfig(), homePath: codexHome },
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            watch: (path) =>
              Stream.unwrap(
                Deferred.succeed(watchedPath, path).pipe(Effect.as(Stream.fromQueue(homeEvents))),
              ),
          }),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              PlatformError.badArgument({
                module: "ChildProcessSpawner",
                method: "spawn",
                description: "The fixture has no Codex executable",
              }),
            ),
          ),
        );
        expect(yield* Deferred.await(watchedPath)).toBe(codexHome);
        let previous = Option.getOrThrow(
          yield* instance.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.liveVoiceAvailable === false),
            Stream.runHead,
          ),
        );
        for (const file of ["auth.json", "config.toml"]) {
          const refreshed = yield* instance.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.checkedAt !== previous.checkedAt),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* Queue.offer(homeEvents, { _tag: "Update", path: file });
          yield* TestClock.adjust("250 millis");

          previous = Option.getOrThrow(yield* Fiber.join(refreshed));
          expect(previous.liveVoiceAvailable).toBe(false);
        }
      }),
  );

  it.effect("watches sharedHomePath config.toml when using shadowHomePath", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-shadow-watch-" });
      const sharedHome = NodePath.join(tempDir, "shared");
      const shadowHome = NodePath.join(tempDir, "shadow");
      yield* fs.makeDirectory(sharedHome, { recursive: true });
      const queues = new Map<string, Queue.Queue<FileSystem.WatchEvent>>();
      const watched = yield* Deferred.make<void>();
      const instance = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-shadow-watch"),
        displayName: "Codex shadow watch",
        enabled: true,
        environment: [],
        config: {
          ...CodexDriver.defaultConfig(),
          homePath: sharedHome,
          shadowHomePath: shadowHome,
        },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          watch: (path) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const queue = yield* Queue.unbounded<FileSystem.WatchEvent>();
                queues.set(path, queue);
                if (queues.has(shadowHome) && queues.has(sharedHome)) {
                  yield* Deferred.succeed(watched, undefined);
                }
                return Stream.fromQueue(queue);
              }),
            ),
        }),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            PlatformError.badArgument({
              module: "ChildProcessSpawner",
              method: "spawn",
              description: "The fixture has no Codex executable",
            }),
          ),
        ),
      );
      yield* Deferred.await(watched);
      const previous = Option.getOrThrow(
        yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.liveVoiceAvailable === false),
          Stream.runHead,
        ),
      );
      const refreshed = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.checkedAt !== previous.checkedAt),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Queue.offer(queues.get(sharedHome)!, { _tag: "Update", path: "config.toml" });
      yield* TestClock.adjust("250 millis");
      const next = Option.getOrThrow(yield* Fiber.join(refreshed));
      expect(next.liveVoiceAvailable).toBe(false);
    }),
  );
});
