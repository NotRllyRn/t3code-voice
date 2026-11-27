import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

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

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.provide(
      DesktopEnvironment.layer({ ...defaultInput, ...overrides }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
        ),
      ),
    ),
  );

describe("DesktopEnvironment Voice", () => {
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

  it.effect("uses fork baseDir, branding, and appUserModelId", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(production.baseDir, "/Users/alice/.t3code-voice");
      assert.equal(production.branding.baseName, "T3 Code Voice");
      assert.equal(production.appUserModelId, "io.github.notrllyrn.t3codevoice");
      assert.equal(development.appUserModelId, "io.github.notrllyrn.t3codevoice.dev");
    }),
  );
});
