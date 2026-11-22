#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Release digests use Node's streaming hash implementation.
import * as NodeCrypto from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DateTime, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { Argument, Command } from "effect/cli";
import { encodeVoiceMacVersion } from "../apps/desktop/src/updates/voiceMacVersion.ts";
import { serializeUpdateManifest } from "./lib/update-manifest.ts";

class VoiceMacFeedError extends Schema.TaggedError<VoiceMacFeedError>()("VoiceMacFeedError", {
  message: Schema.String,
}) {}

// Run only after signing and native bundle verification. Blockmaps must describe these final files.
export const prepareVoiceMacFeed = Effect.fn("prepareVoiceMacFeed")(function* (
  directory: string,
  version: string,
) {
  yield* Effect.try({
    try: () => encodeVoiceMacVersion(version),
    catch: () => new VoiceMacFeedError({ message: "Unsupported Voice macOS version" }),
  });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(directory);
  const names = ["zip", "dmg"].map((extension) => `T3-Code-Voice-${version}-arm64.${extension}`);
  const artifacts = yield* Effect.forEach(
    names.flatMap((name) => [name, `${name}.blockmap`]),
    (name) =>
      Effect.gen(function* () {
        const file = path.join(root, name);
        const info = yield* fs.stat(file);
        if ((yield* fs.realPath(file)) !== file || info.type !== "File" || info.size === 0n)
          return yield* new VoiceMacFeedError({
            message: `Expected regular nonempty artifact: ${name}`,
          });
        const sha256 = NodeCrypto.createHash("sha256");
        const sha512 = NodeCrypto.createHash("sha512");
        yield* fs.stream(file).pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              sha256.update(chunk);
              sha512.update(chunk);
            }),
          ),
        );
        return {
          url: name,
          size: Number(info.size),
          sha256: sha256.digest("hex"),
          sha512: sha512.digest("base64"),
        };
      }),
  );
  const files = artifacts.filter((file) => names.includes(file.url));
  const zip = files[0]!;
  const manifest = serializeUpdateManifest(
    {
      version,
      releaseDate: DateTime.formatIso(yield* DateTime.now),
      files,
      extras: { path: zip.url, sha512: zip.sha512 },
    },
    { platformLabel: "Voice macOS" },
  );
  yield* fs.writeFileString(path.join(root, "latest-mac.yml"), manifest);
  yield* fs.writeFileString(
    path.join(root, "SHA256SUMS"),
    artifacts.map((file) => `${file.sha256}  ${file.url}\n`).join(""),
  );
  return artifacts;
});

const command = Command.make(
  "prepare-voice-macos-feed",
  { directory: Argument.String("directory"), version: Argument.String("version") },
  ({ directory, version }) => prepareVoiceMacFeed(directory, version).pipe(Effect.asVoid),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
