import { Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { voicePublisherRequirement } from "./voiceUpdateConfig.ts";
import { isVoiceMacBundleVersion } from "./voiceMacVersion.ts";

class VoiceMacIdentityError extends Schema.TaggedError<VoiceMacIdentityError>()(
  "VoiceMacIdentityError",
  {},
) {}

const decodePlist = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export const verifyVoiceMacBundleVersion = Effect.fn("VoiceMacIdentity.verifyBundleVersion")(
  function* (appBundle: string, version: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const json = yield* spawner.string(
      ChildProcess.make("/usr/bin/plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        `${appBundle}/Contents/Info.plist`,
      ]),
    );
    const plist = yield* decodePlist(json);
    if (!isVoiceMacBundleVersion(version, plist)) return yield* new VoiceMacIdentityError();
  },
);

export const verifyVoiceMacIdentity = Effect.fn("VoiceMacIdentity.verify")(function* (
  appBundle: string,
  publisherSha1: string,
  version: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--deep",
      "--all-architectures",
      `-R=${voicePublisherRequirement(publisherSha1)}`,
      appBundle,
    ]),
  );
  if (exitCode !== 0) return yield* new VoiceMacIdentityError();
  yield* verifyVoiceMacBundleVersion(appBundle, version);
}, Effect.timeout("30 seconds"));
