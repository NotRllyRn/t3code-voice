// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

const layerShellEnvironment = Layer.succeed(DesktopShellEnvironment.DesktopShellEnvironment, {
  installIntoProcess: Effect.succeed(true),
  awaitDiscovery: Effect.succeed(true),
  awaitUserShellDiscovery: Effect.succeed(true),
  discoveryFinished: Effect.succeed(true),
  updates: Stream.empty,
});

const layerBackendConfiguration = DesktopBackendConfiguration.layer.pipe(
  Layer.provide(layerShellEnvironment),
  Layer.provide(DesktopState.layer),
);

const layerServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 4888,
    bindHost: "0.0.0.0",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
    tailscaleServeEnabled: true,
    tailscaleServePort: 8443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const withHarness = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
  useDefaultHome: boolean,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-config-voice-",
    });

    const layerEnvironment = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: baseDir,
      platform: "darwin",
      processArch: "x64",
      appVersion: "1.2.3",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/missing/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          DesktopConfig.layerTest({
            T3CODE_VOICE_HOME: useDefaultHome ? undefined : baseDir,
            T3CODE_HOME: `${baseDir}/upstream`,
            T3CODE_PORT: "9999",
            T3CODE_MODE: "desktop",
            T3CODE_DESKTOP_LAN_HOST: "192.168.1.50",
          }),
        ),
      ),
    );

    return yield* effect.pipe(
      Effect.provide(
        layerBackendConfiguration.pipe(
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(DesktopWslEnvironment.layerTest()),
          Layer.provideMerge(DesktopWslServerTree.layerTest()),
          Layer.provideMerge(layerEnvironment),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("DesktopBackendConfiguration Voice", () => {
  it.live.each([false, true])(
    "passes isolated home to the owned server subprocess without touching upstream home (default=%s)",
    (useDefaultHome) =>
      withHarness(
        Effect.gen(function* () {
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

          const first = yield* configuration.resolvePrimary;
          assert.equal(first.bootstrap.t3Home, environment.baseDir);
          assert.equal(
            environment.baseDir,
            useDefaultHome
              ? `${environment.homeDirectory}/.t3code-voice`
              : environment.homeDirectory,
          );
          const fileSystem = yield* FileSystem.FileSystem;
          const bootstrapPath = `${environment.homeDirectory}/bootstrap.ndjson`;
          yield* fileSystem.writeFileString(bootstrapPath, `${JSON.stringify(first.bootstrap)}\n`);
          assert.isTrue(first.extendEnv);
          // Resolve real server config in a child without starting a listener or crossing TS project roots.
          const { stdout } = yield* Effect.promise(() =>
            NodeUtil.promisify(NodeChildProcess.execFile)(
              process.execPath,
              [
                "--input-type=module",
                "--eval",
                `
                  import { openSync } from "node:fs";
                  import * as NodeServices from "@effect/platform-node/NodeServices";
                  import * as NetService from "@t3tools/shared/Net";
                  import * as ConfigProvider from "effect/ConfigProvider";
                  import * as Effect from "effect/Effect";
                  import * as Layer from "effect/Layer";
                  import * as Option from "effect/Option";
                  import { resolveServerConfig } from "./src/cli/config.ts";
                  const resolved = await Effect.runPromise(resolveServerConfig({
                    bootstrapFd: Option.some(openSync(process.argv[1], "r")),
                    cwd: Option.some(process.argv[2]),
                  }, Option.none()).pipe(Effect.provide(Layer.mergeAll(
                    NodeServices.layer,
                    NetService.layer,
                    ConfigProvider.layer(ConfigProvider.fromEnv()),
                  ))));
                  console.log(JSON.stringify(resolved));
                `,
                bootstrapPath,
                environment.homeDirectory,
              ],
              {
                cwd: NodeURL.fileURLToPath(new URL("../../../server", import.meta.url)),
                env: {
                  T3CODE_HOME: `${environment.homeDirectory}/upstream`,
                  T3CODE_VOICE_HOME: useDefaultHome ? undefined : environment.homeDirectory,
                  ...first.env,
                },
              },
            ),
          );
          const resolved = JSON.parse(stdout);
          assert.equal(resolved.baseDir, environment.baseDir);
          assert.equal(resolved.dbPath, `${environment.baseDir}/userdata/statev2.sqlite`);
          assert.equal(resolved.settingsPath, `${environment.baseDir}/userdata/settings.json`);
          assert.equal(
            resolved.serverRuntimeStatePath,
            `${environment.baseDir}/userdata/server-runtime.json`,
          );
          assert.equal(resolved.attachmentsDir, `${environment.baseDir}/userdata/attachments`);
          assert.equal(resolved.logsDir, `${environment.baseDir}/userdata/logs`);
          assert.isFalse(yield* fileSystem.exists(`${environment.homeDirectory}/upstream`));
        }),
        useDefaultHome,
      ),
  );
});
