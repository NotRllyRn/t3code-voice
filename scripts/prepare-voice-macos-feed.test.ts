// @effect-diagnostics nodeBuiltinImport:off - Independently verify release digests against Node crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { prepareVoiceMacFeed } from "./prepare-voice-macos-feed.ts";
import { parseUpdateManifest } from "./lib/update-manifest.ts";

it.layer(NodeServices.layer)("Voice macOS feed", (it) => {
  it.effect("hashes final archives and sidecars, with ZIP selected for old clients", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const version = "0.1.10-voice.6";
      const zip = `T3-Code-Voice-${version}-arm64.zip`;
      const dmg = `T3-Code-Voice-${version}-arm64.dmg`;
      for (const name of [zip, dmg, `${zip}.blockmap`, `${dmg}.blockmap`])
        yield* fs.writeFileString(path.join(root, name), name);
      const artifacts = yield* prepareVoiceMacFeed(root, version);
      const manifest = parseUpdateManifest(
        yield* fs.readFileString(path.join(root, "latest-mac.yml")),
        "latest-mac.yml",
        "macOS",
      );
      assert.equal(manifest.version, version);
      assert.deepEqual(
        manifest.files.map((file) => file.url),
        [zip, dmg],
      );
      const digest = NodeCrypto.createHash("sha512").update(zip).digest("base64");
      assert.equal(manifest.files[0]?.sha512, digest);
      assert.equal(manifest.files[0]?.size, zip.length);
      assert.deepEqual(manifest.extras, {}); // Legacy path/hash are emitted, but parser reads files.
      assert.include(yield* fs.readFileString(path.join(root, "latest-mac.yml")), `path: '${zip}'`);
      assert.equal(artifacts.length, 4);
      assert.equal(
        (yield* fs.readFileString(path.join(root, "SHA256SUMS"))).trim().split("\n").length,
        4,
      );
      yield* fs.writeFileString(path.join(root, zip), "signed archive changed");
      assert.notEqual((yield* prepareVoiceMacFeed(root, version))[0]?.sha512, digest);
    }),
  );

  it.effect(
    "refuses invalid versions, incomplete archives and linked sidecars before writing a feed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        for (const version of ["0.1.10-voice.5.1", "0.1.10-voice.1000", "0.1.10", "../bad"])
          assert.isTrue(
            (yield* Effect.result(prepareVoiceMacFeed(root, version)))._tag === "Failure",
          );
        const version = "0.1.10-voice.7";
        const zip = path.join(root, `T3-Code-Voice-${version}-arm64.zip`);
        yield* fs.writeFileString(zip, "zip");
        assert.isTrue(
          (yield* Effect.result(prepareVoiceMacFeed(root, version)))._tag === "Failure",
        );
        yield* fs.symlink(zip, `${zip}.blockmap`);
        assert.isTrue(
          (yield* Effect.result(prepareVoiceMacFeed(root, version)))._tag === "Failure",
        );
        assert.isFalse(yield* fs.exists(path.join(root, "latest-mac.yml")));
      }),
  );
});
