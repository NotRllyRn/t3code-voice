import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { VOICE_UPDATE_FEED } from "./voiceUpdateConfig.ts";
import { loadVoiceUpdateConfig } from "./voiceUpdateLoader.ts";

const config = {
  track: "voice-stable" as const,
  feedUrl: VOICE_UPDATE_FEED,
  publisherSha1: "a".repeat(40),
};
const packageJson = JSON.stringify({ t3VoiceUpdate: config });
const plist = JSON.stringify({
  CFBundleShortVersionString: "0.1.10001",
  ElectronSquirrelPreventDowngrades: true,
});
const readError = PlatformError.systemError({
  module: "FileSystem",
  method: "readFileString",
  _tag: "PermissionDenied",
});

function fixture(path: Path.Path, raw: string | undefined, identity = "valid") {
  const events: Array<string | ChildProcess.Command> = [];
  const spawner = {
    ...ChildProcessSpawner.make(() => Effect.die("unexpected process spawn")),
    exitCode: (command: ChildProcess.Command) =>
      Effect.sync(() => {
        events.push(command);
        return ChildProcessSpawner.ExitCode(identity === "rejected" ? 1 : 0);
      }),
    string: (command: ChildProcess.Command) =>
      Effect.sync(() => {
        events.push(command);
        return identity === "malformed-plist" ? "{" : plist;
      }).pipe(
        Effect.filterOrFail(
          () => identity !== "read-error",
          () => readError,
        ),
      ),
  };
  const load = loadVoiceUpdateConfig(
    {
      readFileString: (file) =>
        Effect.sync(() => {
          events.push(file);
        }).pipe(Effect.andThen(raw === undefined ? Effect.fail(readError) : Effect.succeed(raw))),
    },
    {
      path,
      appPath: "/fixture/Test.app/Contents/Resources/app.asar",
      resourcesPath: "/fixture/Test.app/Contents/Resources",
      appVersion: "0.1.10-voice.1",
    },
    spawner,
  );
  return { events, load };
}

it.effect("returns null for unreadable or malformed packages without native probes", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    for (const raw of [undefined, "{", "null", "[]", "{}", '{"t3VoiceUpdate":{}}']) {
      const { events, load } = fixture(path, raw);
      assert.deepEqual(events, []);
      assert.isNull(yield* load);
      assert.deepEqual(events, ["/fixture/Test.app/Contents/Resources/app.asar/package.json"]);
    }
  }).pipe(Effect.provide(Path.layer)),
);

it.effect.each(["valid", "rejected", "malformed-plist", "read-error"])(
  "validates the resolved bundle before returning config: %s",
  (identity) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { events, load } = fixture(path, packageJson, identity);
      assert.deepEqual(events, []);
      assert.deepEqual(yield* load, identity === "valid" ? config : null);
      assert.equal(events[0], "/fixture/Test.app/Contents/Resources/app.asar/package.json");
      assert.deepEqual(
        events[1],
        ChildProcess.make("/usr/bin/codesign", [
          "--verify",
          "--strict",
          "--deep",
          "--all-architectures",
          '-R=identifier "io.github.notrllyrn.t3codevoice" and certificate leaf = H"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
          "/fixture/Test.app",
        ]),
      );
      assert.equal(events.length, identity === "rejected" ? 2 : 3);
      if (identity !== "rejected") {
        assert.deepEqual(
          events[2],
          ChildProcess.make("/usr/bin/plutil", [
            "-convert",
            "json",
            "-o",
            "-",
            "/fixture/Test.app/Contents/Info.plist",
          ]),
        );
      }
    }).pipe(Effect.provide(Path.layer)),
);
