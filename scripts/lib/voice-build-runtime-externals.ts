import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Return the first missing manifest; copy only after all required manifests exist. */
export const copyVerifiedRuntimeExternals = Effect.fn("copyVerifiedRuntimeExternals")(function* (
  sourceDir: string,
  stageDir: string,
  dependencies: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of dependencies) {
    const manifest = path.join(sourceDir, name, "package.json");
    if (!(yield* fs.exists(manifest))) return manifest;
  }
  yield* fs.copy(sourceDir, path.join(stageDir, "node_modules"));
  return undefined;
});
