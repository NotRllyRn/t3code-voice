import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const withPackageJson = (packageJson: string) => {
  const setAboutPanelOptions: Array<Electron.AboutPanelOptionsOptions> = [];
  const effect = Effect.gen(function* () {
    const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
    yield* identity.configure;
    return setAboutPanelOptions;
  });
  return effect.pipe(
    Effect.provide(
      DesktopAppIdentity.layer.pipe(
        Layer.provide(NodePath.layerPosix),
        Layer.provideMerge(
          FileSystem.layerNoop({
            exists: () => Effect.succeed(false),
            readFileString: () => Effect.succeed(packageJson),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopAssets.DesktopAssets, {
            iconPaths: Effect.succeed({
              ico: Option.none(),
              icns: Option.none(),
              png: Option.none(),
            }),
            resolveResourcePath: () => Effect.succeedNone,
          } satisfies DesktopAssets.DesktopAssets["Service"]),
        ),
        Layer.provideMerge(
          Layer.succeed(ElectronApp.ElectronApp, {
            metadata: Effect.die("unexpected metadata read"),
            name: Effect.succeed("T3 Code"),
            systemLocale: Effect.succeed("en-US"),
            preferredSystemLanguages: Effect.succeed(["en-US"]),
            whenReady: Effect.void,
            requestSingleInstanceLock: Effect.succeed(true),
            quit: Effect.void,
            exit: () => Effect.void,
            relaunch: () => Effect.void,
            setPath: () => Effect.void,
            setName: () => Effect.void,
            setAboutPanelOptions: (options) =>
              Effect.sync(() => {
                setAboutPanelOptions.push(options);
              }),
            setAppUserModelId: () => Effect.void,
            getAppMetrics: Effect.succeed([]),
            setAsDefaultProtocolClient: () => Effect.succeed(true),
            setDesktopName: () => Effect.void,
            setDockIcon: () => Effect.void,
            appendCommandLineSwitch: () => Effect.void,
            onBeforeQuitForUpdate: () => Effect.void,
            removeCommandLineSwitch: () => Effect.void,
            on: () => Effect.void,
          } satisfies ElectronApp.ElectronApp["Service"]),
        ),
        Layer.provideMerge(
          DesktopEnvironment.layer(defaultEnvironmentInput).pipe(
            Layer.provide(
              Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
            ),
          ),
        ),
      ),
    ),
  );
};

describe("DesktopAppIdentity (voice)", () => {
  it.effect.each([
    { packageJson: "{}", expected: "unknown" },
    { packageJson: '{"t3codeCommitHash":"invalid"}', expected: "unknown" },
    {
      packageJson: '{"t3codeCommitHash":"0123456789012345678901234567890123456789"}',
      expected: "012345678901",
    },
  ])("reports embedded source metadata honestly ($expected)", ({ packageJson, expected }) =>
    Effect.gen(function* () {
      const calls = yield* withPackageJson(packageJson);
      assert.equal(calls[0]?.version, expected);
    }),
  );
});
