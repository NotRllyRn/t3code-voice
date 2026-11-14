import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("ignores ambient upstream home and preserves explicit fork paths", () =>
    Effect.gen(function* () {
      const ambient = { T3CODE_HOME: "/must-not-read-upstream" };
      assert.equal(
        (yield* makeEnvironment({}, ambient)).stateDir,
        "/Users/alice/.t3code-voice/userdata",
      );
      const explicit = { ...ambient, T3CODE_VOICE_HOME: " /owned/voice-test " };
      assert.equal((yield* makeEnvironment({}, explicit)).stateDir, "/owned/voice-test/userdata");
      assert.equal(
        (yield* makeEnvironment({}, { ...explicit, VITE_DEV_SERVER_URL: "http://localhost:5173" }))
          .stateDir,
        "/owned/voice-test/userdata",
      );
      assert.equal(
        (yield* makeEnvironment({}, { ...ambient, T3CODE_VOICE_HOME: " " })).baseDir,
        "/Users/alice/.t3code-voice",
      );
    }),
  );
  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.t3code-voice/dev");
      assert.equal(production.baseDir, "/Users/alice/.t3code-voice");
      assert.equal(production.stateDir, "/Users/alice/.t3code-voice/userdata");
      assert.equal(production.branding.baseName, "T3 Code Voice");
      assert.equal(production.appUserModelId, "io.github.notrllyrn.t3codevoice");
      assert.equal(development.appUserModelId, "io.github.notrllyrn.t3codevoice.dev");
    }),
  );
});
