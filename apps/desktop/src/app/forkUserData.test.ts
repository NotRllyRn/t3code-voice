import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

it.effect.each([
  { platform: "darwin", isDevelopment: false },
  { platform: "darwin", isDevelopment: true },
  { platform: "win32", isDevelopment: false },
  { platform: "win32", isDevelopment: true },
] as const)(
  "never probes or migrates upstream profiles on $platform (dev=$isDevelopment)",
  ({ platform, isDevelopment }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "voice-profile-" });
      for (const name of [
        "t3code",
        "t3code-v2",
        "t3code-dev",
        "T3 Code (Alpha)",
        "T3 Code (Dev)",
      ]) {
        yield* fs.makeDirectory(path.join(directory, name), { recursive: true });
        yield* fs.writeFileString(path.join(directory, name, "Local State"), "upstream state");
      }
      const profile = yield* DesktopAppIdentity.make.pipe(
        Effect.flatMap((identity) => identity.resolveUserDataPath),
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          appDataDirectory: directory,
          isDevelopment,
          platform,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(
          DesktopAssets.DesktopAssets,
          {} as DesktopAssets.DesktopAssets["Service"],
        ),
        Effect.provideService(ElectronApp.ElectronApp, {} as ElectronApp.ElectronApp["Service"]),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: () => Effect.die("must not probe upstream profiles"),
            readFileString: () => Effect.die("must not read upstream state"),
            writeFileString: () => Effect.die("must not migrate upstream state"),
          }),
        ),
      );
      assert.equal(
        profile,
        path.join(directory, isDevelopment ? "t3code-voice-dev" : "t3code-voice"),
      );
      assert.isFalse(yield* fs.exists(profile));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
