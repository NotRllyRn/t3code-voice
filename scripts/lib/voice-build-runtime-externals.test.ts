import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { copyVerifiedRuntimeExternals } from "./voice-build-runtime-externals.ts";

it.layer(NodeServices.layer)("verified runtime externals", (it) => {
  it.effect("checks every manifest before copying and preserves the supplied tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "voice-externals-" });
      const source = path.join(root, "source");
      const stage = path.join(root, "stage");
      const dependency = path.join(source, "@scope/native");
      yield* fs.makeDirectory(dependency, { recursive: true });
      yield* fs.makeDirectory(stage);
      yield* fs.writeFileString(path.join(dependency, "package.json"), '{"name":"@scope/native"}');
      yield* fs.writeFileString(path.join(dependency, "binding.node"), "target-binary");
      const missing = path.join(source, "other/package.json");
      assert.equal(
        yield* copyVerifiedRuntimeExternals(source, stage, ["@scope/native", "other"]),
        missing,
      );
      assert.isFalse(yield* fs.exists(path.join(stage, "node_modules")));
      yield* fs.makeDirectory(path.join(source, "other"));
      yield* fs.writeFileString(missing, '{"name":"other"}');
      assert.isUndefined(
        yield* copyVerifiedRuntimeExternals(source, stage, ["@scope/native", "other"]),
      );
      assert.equal(
        yield* fs.readFileString(path.join(stage, "node_modules/@scope/native/binding.node")),
        "target-binary",
      );
      assert.equal(
        yield* fs.readFileString(path.join(stage, "node_modules/other/package.json")),
        '{"name":"other"}',
      );
      assert.equal(
        yield* fs.readFileString(path.join(dependency, "binding.node")),
        "target-binary",
      );
    }).pipe(Effect.scoped),
  );
});
