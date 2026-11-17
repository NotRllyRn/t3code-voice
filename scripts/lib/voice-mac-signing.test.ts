import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Sink, Stream } from "effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ChildProcessSpawner } from "effect/process";
import { resolveVoiceMacUpdate, signVoiceMacApp } from "./voice-mac-signing.ts";
import { VOICE_UPDATE_FEED } from "../../apps/desktop/src/updates/voiceUpdateConfig.ts";

const input = {
  platform: "mac",
  target: "dmg",
  version: "0.1.10-voice.1",
  signed: true,
  repoRoot: "/repo",
};
it.effect(
  "leaves default builds manual and refuses partial or unsigned opt-ins before touching keys",
  () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* resolveVoiceMacUpdate({}, input));
      const full = {
        T3VOICE_MAC_UPDATE_FEED: VOICE_UPDATE_FEED,
        T3VOICE_MAC_CERT: "/private/cert.pem",
        T3VOICE_MAC_KEY: "/private/key.pem",
        T3VOICE_RCODESIGN: "/private/rcodesign",
      };
      assert.match(
        (yield* Effect.flip(
          resolveVoiceMacUpdate(full, { ...input, version: "0.1.10-voice.1000" }),
        )).message,
        /Unsupported Voice native/,
      );
      for (const env of [
        { ...full, T3VOICE_MAC_UPDATE_TRACK: "voice-candidate" },
        { ...full, T3VOICE_MAC_UPDATE_TRACK: "anything" },
        { ...full, T3VOICE_MAC_UPDATE_FEED: "https://example.com/" },
      ]) {
        assert.match(
          (yield* Effect.flip(resolveVoiceMacUpdate(env, input))).message,
          /Invalid fork feed/,
        );
      }
      for (const [env, build] of [
        [{ T3VOICE_MAC_UPDATE_TRACK: "voice-candidate" }, input],
        [{ T3VOICE_MAC_UPDATE_FEED: VOICE_UPDATE_FEED }, input],
        [full, { ...input, signed: false }],
        [full, { ...input, platform: "linux" }],
        [full, { ...input, target: "dir" }],
      ] as const) {
        assert.match(
          (yield* Effect.flip(resolveVoiceMacUpdate(env, build))).message,
          /requires a signed macOS/,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses to sign an unguarded or mismapped final plist before reading keys", () =>
  Effect.gen(function* () {
    for (const plist of [
      { CFBundleShortVersionString: "0.1.10001" },
      { CFBundleShortVersionString: "0.1.10001", ElectronSquirrelPreventDowngrades: false },
      { CFBundleShortVersionString: "0.1.10002", ElectronSquirrelPreventDowngrades: true },
      { CFBundleShortVersionString: "0.1.10-voice.1", ElectronSquirrelPreventDowngrades: true },
    ]) {
      const commands: string[] = [];
      const failure = yield* Effect.result(
        signVoiceMacApp("/fixture.app", "/repo", input.version).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              assert.equal(command._tag, "StandardCommand");
              if (command._tag === "StandardCommand") commands.push(command.command);
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(1),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: Stream.make(new TextEncoder().encode(JSON.stringify(plist))),
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              );
            }),
          ),
        ),
      );
      assert.equal(failure._tag, "Failure");
      assert.deepEqual(commands, ["/usr/bin/plutil"]);
    }
  }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
    Effect.provide(NodeServices.layer),
  ),
);
