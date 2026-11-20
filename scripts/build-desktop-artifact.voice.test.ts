import * as NodeModule from "node:module";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  createBuildConfig,
  resolveDesktopBuildCommit,
  DesktopBuildCommitError,
} from "./build-desktop-artifact.ts";

function mockProcess(exitCode: number, stdout = "") {
  const encodedStdout = new TextEncoder().encode(stdout);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(encodedStdout) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

it.layer(NodeServices.layer)("build-desktop-artifact Voice", (it) => {
  it.effect("isolates macOS identity and refuses all inferred or mock update feeds", () =>
    Effect.gen(function* () {
      for (const version of [
        "0.0.33-pr.8182.1",
        "0.0.33",
        "0.0.41-preview.20260912.1589",
        "0.0.43-nightly.20260929.1",
      ]) {
        for (const mock of [false, true]) {
          const config = yield* createBuildConfig(
            "mac",
            "dmg",
            version,
            false,
            mock,
            4141,
            undefined,
          );
          assert.isNull(config.publish);
          assert.equal(config.appId, "io.github.notrllyrn.t3codevoice");
          assert.equal(
            config.productName,
            version.includes("nightly") ? "T3 Code Voice (Nightly)" : "T3 Code Voice",
          );
          assert.equal(config.artifactName, "T3-Code-Voice-${version}-${arch}.${ext}");
          assert.deepEqual((config.mac as { protocols: unknown }).protocols, [
            { name: "T3 Code Voice", schemes: ["t3code-voice", "t3code-voice-dev"] },
          ]);
          assert.notProperty(
            (config.mac as { extendInfo: object }).extendInfo,
            "CFBundleDocumentTypes",
          );
          assert.notProperty(config.mac, "bundleShortVersion");
          assert.notProperty(
            (config.mac as { extendInfo: object }).extendInfo,
            "ElectronSquirrelPreventDowngrades",
          );
        }
      }
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              GITHUB_REPOSITORY: "pingdotgg/t3code",
              T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
            },
          }),
        ),
      ),
    ),
  );

  it.effect(
    "keeps stable and nightly AppImages manual-only despite upstream publishing config",
    () =>
      Effect.gen(function* () {
        for (const version of ["0.0.37", "0.0.38-nightly.20261026.3740"]) {
          const config = yield* createBuildConfig(
            "linux",
            "AppImage",
            version,
            false,
            false,
            undefined,
            undefined,
          );
          assert.isNull(config.publish);
          assert.isUndefined(config.appImage);
          assert.equal(config.artifactName, "T3-Code-Voice-${version}-${arch}.${ext}");
        }
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "pingdotgg/t3code" } }),
          ),
        ),
      ),
  );

  it.effect("publishes latest-mac only for an explicit signed Voice stable configuration", () =>
    Effect.gen(function* () {
      const voice = {
        track: "voice-stable" as const,
        feedUrl: "https://github.com/NotRllyRn/t3code-voice/releases/download/voice-stable/",
        publisherSha1: "a".repeat(40),
      };
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.1.10-voice.1",
        true,
        false,
        4141,
        undefined,
        undefined,
        "arm64",
        voice,
      );
      assert.deepEqual(config.publish, {
        provider: "generic",
        url: voice.feedUrl,
        channel: "latest",
      });
      assert.deepEqual(config.extraMetadata, { t3VoiceUpdate: voice });
      const candidate = {
        ...voice,
        track: "voice-candidate" as const,
        feedUrl: "https://github.com/NotRllyRn/t3code-voice/releases/download/voice-candidate/",
      };
      const candidateConfig = yield* createBuildConfig(
        "mac",
        "zip",
        "0.1.10-voice.2",
        true,
        false,
        4141,
        undefined,
        undefined,
        "arm64",
        candidate,
      );
      assert.deepEqual(candidateConfig.publish, {
        provider: "generic",
        url: candidate.feedUrl,
        channel: "latest",
      });
      assert.deepEqual(candidateConfig.extraMetadata, { t3VoiceUpdate: candidate });
      assert.include(candidateConfig.productName as string, "Candidate — Not Production");
      assert.nestedPropertyVal(
        candidateConfig,
        "mac.extendInfo.ElectronSquirrelPreventDowngrades",
        true,
      );
      assert.nestedPropertyVal(candidateConfig, "mac.bundleShortVersion", "0.1.10002");
      const crossMixed = yield* Effect.result(
        createBuildConfig(
          "mac",
          "zip",
          "0.1.10-voice.2",
          true,
          false,
          4141,
          undefined,
          undefined,
          "arm64",
          { ...candidate, feedUrl: voice.feedUrl },
        ),
      );
      assert.equal(crossMixed._tag, "Failure");
      assert.equal(config.generateUpdatesFilesForAllChannels, false);
      assert.include((config.mac as { sign: string }).sign, "sign-voice-macos.ts");
      assert.equal((config.mac as { hardenedRuntime: boolean }).hardenedRuntime, true);
      assert.equal((config.mac as { identity: string }).identity, "-");
      assert.nestedPropertyVal(config, "mac.bundleShortVersion", "0.1.10001");
      assert.nestedPropertyVal(config, "mac.extendInfo.ElectronSquirrelPreventDowngrades", true);
      // Exercise installed builder field selection, not a mirror of its plist assignments.
      const desktopRequire = NodeModule.createRequire(
        new URL("../apps/desktop/package.json", import.meta.url),
      );
      const builderRequire = NodeModule.createRequire(
        desktopRequire.resolve("electron-builder/package.json"),
      );
      builderRequire("app-builder-lib");
      const { MacPackager } = builderRequire("app-builder-lib/out/macPackager.js") as {
        MacPackager: {
          prototype: {
            applyCommonInfo(this: object, plist: object, contents: string): Promise<void>;
          };
        };
      };
      const plist: Record<string, unknown> = {};
      yield* Effect.promise(() =>
        MacPackager.prototype.applyCommonInfo.call(
          {
            appInfo: {
              productFilename: "Voice",
              productName: "Voice",
              version: "0.1.10-voice.1",
              buildVersion: "77.88.99",
            },
            platformSpecificBuildOptions: config.mac,
            config: {},
            getIconPath: async () => null,
          },
          plist,
          "/unused",
        ),
      );
      assert.equal(plist.CFBundleShortVersionString, "0.1.10001");
      assert.equal(plist.CFBundleVersion, "77.88.99");
      assert.equal(plist.ElectronSquirrelPreventDowngrades, true);
      const overflow = yield* Effect.result(
        createBuildConfig(
          "mac",
          "zip",
          "0.1.10-voice.1000",
          true,
          false,
          undefined,
          undefined,
          false,
          "arm64",
          voice,
        ),
      );
      assert.equal(overflow._tag, "Failure");
      const unsigned = yield* Effect.flip(
        createBuildConfig(
          "mac",
          "dmg",
          "0.1.10-voice.1",
          false,
          false,
          4141,
          undefined,
          undefined,
          "arm64",
          voice,
        ),
      );
      assert.match(unsigned.message, /Invalid Voice/);
    }),
  );

  it.effect.each([
    { label: "clean Git", git: true, explicit: undefined, dirty: false, accepted: true },
    {
      label: "matching explicit Git",
      git: true,
      explicit: "a".repeat(40),
      dirty: false,
      accepted: true,
    },
    { label: "mismatched Git", git: true, explicit: "b".repeat(40), dirty: false, accepted: false },
    { label: "dirty Git", git: true, explicit: undefined, dirty: true, accepted: false },
    {
      label: "verified gitless input",
      git: false,
      explicit: "a".repeat(40),
      dirty: false,
      accepted: true,
    },
    { label: "unknown gitless", git: false, explicit: undefined, dirty: false, accepted: false },
    { label: "invalid gitless", git: false, explicit: "unknown", dirty: false, accepted: false },
    { label: "short gitless", git: false, explicit: "abcdef123456", dirty: false, accepted: false },
  ])("requires full honest source metadata: $label", ({ git, explicit, dirty, accepted }) =>
    Effect.gen(function* () {
      const outputs = git ? ["/source", "a".repeat(40), dirty ? " M source.ts" : ""] : [];
      const result = yield* Effect.result(
        resolveDesktopBuildCommit("/source").pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(mockProcess(git ? 0 : 1, outputs.shift() ?? "")),
            ),
          ),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: explicit === undefined ? {} : { T3CODE_VOICE_BUILD_COMMIT: explicit },
              }),
            ),
          ),
        ),
      );
      if (accepted) {
        assert.equal(result._tag, "Success");
        if (result._tag === "Success") assert.equal(result.success, "a".repeat(40));
      } else {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.instanceOf(result.failure, DesktopBuildCommitError);
      }
    }),
  );
});
