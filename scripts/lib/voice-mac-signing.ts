import * as HostProcess from "@t3tools/shared/HostProcess";
import { encodeVoiceMacVersion } from "../../apps/desktop/src/updates/voiceMacVersion.ts";
import { verifyVoiceMacBundleVersion } from "../../apps/desktop/src/updates/voiceMacIdentity.ts";
import { Clock, Config, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  parseVoiceUpdateConfig,
  voicePublisherRequirement,
} from "../../apps/desktop/src/updates/voiceUpdateConfig.ts";

export class VoiceMacSigningError extends Schema.TaggedError<VoiceMacSigningError>()(
  "VoiceMacSigningError",
  { message: Schema.String },
) {}

const variables = [
  "T3VOICE_MAC_UPDATE_FEED",
  "T3VOICE_MAC_CERT",
  "T3VOICE_MAC_KEY",
  "T3VOICE_RCODESIGN",
] as const;

const run = Effect.fn("VoiceMacSigning.run")(function* (executable: string, args: string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make(executable, args));
      const [output, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0)
        return yield* new VoiceMacSigningError({ message: "Voice signing command failed" });
      return output;
    }),
  );
});

const privateFile = Effect.fn("VoiceMacSigning.privateFile")(function* (
  file: string,
  repoRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(file))
    return yield* new VoiceMacSigningError({ message: "Voice signing paths must be absolute" });
  const resolved = yield* fs.realPath(file);
  const relative = path.relative(yield* fs.realPath(repoRoot), resolved);
  const info = yield* fs.stat(resolved);
  const directory = yield* fs.stat(path.dirname(resolved));
  if (
    (!relative.startsWith(`..${path.sep}`) && relative !== "..") ||
    info.type !== "File" ||
    (info.mode & 0o077) !== 0 ||
    (directory.mode & 0o077) !== 0 ||
    Option.getOrUndefined(info.uid) !== (yield* HostProcess.UserId) ||
    Option.getOrUndefined(directory.uid) !== Option.getOrUndefined(info.uid)
  )
    return yield* new VoiceMacSigningError({
      message:
        "Voice signing files must be owner-only, outside the checkout, in a private directory",
    });
  return resolved;
});

export const resolveVoiceMacUpdate = Effect.fn("VoiceMacSigning.resolve")(function* (
  env: NodeJS.ProcessEnv,
  input: { platform: string; target: string; version: string; signed: boolean; repoRoot: string },
) {
  if (!variables.some((key) => env[key] !== undefined)) return undefined;
  if (
    variables.some((key) => !env[key]) ||
    input.platform !== "mac" ||
    !input.signed ||
    !["dmg", "zip"].includes(input.target)
  )
    return yield* new VoiceMacSigningError({
      message:
        "Voice self-update requires a signed macOS zip/dmg and all four T3VOICE signing settings",
    });
  yield* Effect.try({
    try: () => encodeVoiceMacVersion(input.version),
    catch: () => new VoiceMacSigningError({ message: "Unsupported Voice native macOS version" }),
  });
  const cert = yield* privateFile(env.T3VOICE_MAC_CERT!, input.repoRoot);
  const key = yield* privateFile(env.T3VOICE_MAC_KEY!, input.repoRoot);
  yield* privateFile(env.T3VOICE_RCODESIGN!, input.repoRoot);
  const certificatePublicKey = yield* run("/usr/bin/openssl", [
    "x509",
    "-in",
    cert,
    "-noout",
    "-pubkey",
    "-checkend",
    "0",
  ]);
  const privatePublicKey = yield* run("/usr/bin/openssl", [
    "pkey",
    "-in",
    key,
    "-passin",
    "pass:",
    "-pubout",
  ]);
  const startDate = yield* run("/usr/bin/openssl", ["x509", "-in", cert, "-noout", "-startdate"]);
  const now = yield* Clock.currentTimeMillis;
  const begins = Date.parse(startDate.trim().replace(/^notBefore=/, ""));
  if (
    !Number.isFinite(begins) ||
    now < begins ||
    !certificatePublicKey.includes(privatePublicKey.trim())
  )
    return yield* new VoiceMacSigningError({
      message: "Voice certificate/key mismatch or invalid certificate dates",
    });
  const fingerprint = yield* run("/usr/bin/openssl", [
    "x509",
    "-in",
    cert,
    "-noout",
    "-fingerprint",
    "-sha1",
  ]);
  const config = parseVoiceUpdateConfig(
    {
      track: "voice-stable",
      feedUrl: env.T3VOICE_MAC_UPDATE_FEED,
      publisherSha1: fingerprint.trim().split("=").at(-1)?.replaceAll(":", "").toLowerCase(),
    },
    input.version,
  );
  if (!config)
    return yield* new VoiceMacSigningError({ message: "Invalid fork feed or Voice version" });
  return config;
});

export const signVoiceMacApp = Effect.fn("VoiceMacSigning.sign")(function* (
  app: string,
  repoRoot: string,
  version: string,
) {
  if ((yield* HostProcess.Platform) !== "darwin" || (yield* HostProcess.Architecture) !== "arm64")
    return yield* new VoiceMacSigningError({
      message: "Pinned Voice rcodesign driver currently requires macOS arm64",
    });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Validate the final builder plist against the packaged semantic version before sealing it.
  yield* verifyVoiceMacBundleVersion(app, version);
  const env = yield* Config.all({
    T3VOICE_MAC_UPDATE_FEED: Config.String("T3VOICE_MAC_UPDATE_FEED"),
    T3VOICE_MAC_CERT: Config.String("T3VOICE_MAC_CERT"),
    T3VOICE_MAC_KEY: Config.String("T3VOICE_MAC_KEY"),
    T3VOICE_RCODESIGN: Config.String("T3VOICE_RCODESIGN"),
  });
  const config = yield* resolveVoiceMacUpdate(env, {
    platform: "mac",
    target: "zip",
    version,
    signed: true,
    repoRoot,
  });
  if (!config)
    return yield* new VoiceMacSigningError({ message: "Missing Voice signing configuration" });
  const signer = yield* fs.realPath(env.T3VOICE_RCODESIGN);
  yield* run("/usr/bin/codesign", [
    "--verify",
    "--strict",
    '-R=anchor apple generic and certificate leaf[subject.OU] = MK22MZP987 and cdhash H"b19a77eacc2cc2c524b3af822ecaa29c33f4d418"',
    signer,
  ]);
  if ((yield* run(signer, ["-C", "/dev/null", "--version"])).trim() !== "apple-codesign 0.29.0")
    return yield* new VoiceMacSigningError({ message: "Unexpected rcodesign version" });
  yield* run(signer, [
    "-C",
    "/dev/null",
    "sign",
    "--timestamp-url",
    "none",
    "--pem-file",
    yield* fs.realPath(env.T3VOICE_MAC_CERT),
    "--pem-file",
    yield* fs.realPath(env.T3VOICE_MAC_KEY),
    "--code-signature-flags",
    "main:runtime",
    "--entitlements-xml-file",
    `main:${path.join(repoRoot, "apps/desktop/resources/entitlements.voice.plist")}`,
    app,
  ]);
  yield* run("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--deep",
    "--all-architectures",
    `-R=${voicePublisherRequirement(config.publisherSha1)}`,
    app,
  ]);
  yield* verifyVoiceMacBundleVersion(app, version);
});
