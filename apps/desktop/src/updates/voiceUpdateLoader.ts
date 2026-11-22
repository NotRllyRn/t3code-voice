import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import type { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { verifyVoiceMacIdentity } from "./voiceMacIdentity.ts";
import { parseVoiceUpdateConfig, type VoiceUpdateConfig } from "./voiceUpdateConfig.ts";

export function loadVoiceUpdateConfig(
  fileSystem: Pick<FileSystem.FileSystem, "readFileString">,
  environment: Pick<
    DesktopEnvironment["Service"],
    "path" | "appPath" | "resourcesPath" | "appVersion"
  >,
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.Effect<VoiceUpdateConfig | null> {
  return fileSystem.readFileString(environment.path.join(environment.appPath, "package.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
    Effect.map((pkg) =>
      parseVoiceUpdateConfig(
        typeof pkg === "object" && pkg !== null && "t3VoiceUpdate" in pkg
          ? pkg.t3VoiceUpdate
          : null,
        environment.appVersion,
      ),
    ),
    Effect.flatMap((candidate) =>
      candidate === null
        ? Effect.succeed(null)
        : verifyVoiceMacIdentity(
            environment.path.resolve(environment.resourcesPath, "../.."),
            candidate.publisherSha1,
            environment.appVersion,
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.as(candidate),
          ),
    ),
    Effect.orElseSucceed(() => null),
  );
}
