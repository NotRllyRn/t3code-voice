import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { linuxLibatomicHeader } from "./voice-build-libatomic.ts";
import { copyVerifiedRuntimeExternals } from "./voice-build-runtime-externals.ts";

export { linuxLibatomicHeader };

export const tryStageVoiceRuntimeExternals = Effect.fn("tryStageVoiceRuntimeExternals")(function* <
  E,
>(
  runtimeExternalsDir: Option.Option<string>,
  stageDir: string,
  dependencies: Record<string, string>,
  missingError: (inputPath: string, hint: string) => E,
) {
  if (Option.isNone(runtimeExternalsDir)) return false;
  const missing = yield* copyVerifiedRuntimeExternals(
    runtimeExternalsDir.value,
    stageDir,
    Object.keys(dependencies),
  );
  if (missing !== undefined) {
    return yield* Effect.fail(
      missingError(
        missing,
        "Supply a verified runtime node_modules directory with all target dependencies.",
      ),
    );
  }
  return true;
});

export const resolveVoiceLibatomicHeader = Effect.fn("resolveVoiceLibatomicHeader")(function* <E>(
  info: {
    readonly pkg: string;
    readonly version: string;
    readonly sourcePackage: string;
    readonly sourceVersion: string;
  },
  missingError: (inputPath: string, hint: string) => E,
) {
  const fs = yield* FileSystem.FileSystem;
  const header = linuxLibatomicHeader(yield* fs.readFileString("/etc/os-release"), info);
  if (header === undefined) {
    return yield* Effect.fail(
      missingError(
        "/etc/os-release#ID",
        "Build Linux archives on Debian or Ubuntu to identify libatomic's source package.",
      ),
    );
  }
  return header;
});
