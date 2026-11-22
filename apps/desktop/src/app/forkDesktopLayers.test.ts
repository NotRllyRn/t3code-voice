import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as ForkDesktopLayers from "./forkDesktopLayers.ts";

const environmentFor = (path: Path.Path, home: string) =>
  DesktopEnvironment.DesktopEnvironment.of({
    path,
    platform: "linux",
    isPackaged: true,
    isDevelopment: false,
    homeDirectory: home,
    baseDir: path.join(home, ".voice"),
    stateDir: path.join(home, ".voice", "userdata"),
    desktopSettingsPath: path.join(home, ".voice", "userdata", "desktop-settings.json"),
    appDataDirectory: path.join(home, "app-data"),
    serverRoot: path.join(home, "app.asar"),
    appImagePath: Option.none(),
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

it.layer(NodeServices.layer)("fork startup layers", (it) => {
  it.effect(
    "does not install at first launch; manual install, PATH, state and removal still work",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const environment = environmentFor(path, home);
        yield* fs.makeDirectory(environment.stateDir, { recursive: true });
        const launcher = DesktopCliShim.launcherPath(environment);
        const link = path.join(home, ".local", "bin", "t3");
        const marker = path.join(environment.stateDir, "cli-command-first-launch");
        const probes: string[] = [];
        const observedFs = {
          ...fs,
          exists: (target: string) =>
            Effect.sync(() => probes.push(target)).pipe(Effect.andThen(fs.exists(target))),
        };

        yield* Effect.gen(function* () {
          const command = yield* DesktopCliCommand.DesktopCliCommand;
          // Construction retains the upstream fresh-install check, confined to the fork home.
          expect(probes).toEqual([launcher, environment.desktopSettingsPath]);
          expect(yield* fs.exists(launcher)).toBe(false);
          yield* command.installOnFirstLaunch;
          yield* command.installOnFirstLaunch;
          expect(yield* fs.exists(link)).toBe(false);
          expect(yield* fs.exists(launcher)).toBe(false);
          expect(yield* fs.exists(marker)).toBe(false);
          expect((yield* command.state).installedPath).toBeNull();

          expect((yield* command.install).installedPath).toBe(link);
          expect(yield* fs.readLink(link)).toBe(launcher);
          expect(yield* fs.readFileString(launcher)).toContain(DesktopCliShim.MARKER);
          expect((yield* command.addToPath).pathSetup).toEqual({
            file: "~/.zshrc",
            added: true,
          });
          yield* command.addToPath;
          expect(yield* fs.readFileString(path.join(home, ".zshrc"))).toBe(
            '\n# Added by T3 Code\nexport PATH="$PATH:$HOME/.local/bin"\n',
          );
          expect((yield* command.state).installedPath).toBe(link);
          expect((yield* command.uninstall).installedPath).toBeNull();
          yield* command.installOnFirstLaunch;
          expect(yield* fs.exists(link)).toBe(false);
          expect(yield* fs.exists(launcher)).toBe(true);
        }).pipe(
          Effect.provide(ForkDesktopLayers.cliCommandLayer),
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(FileSystem.FileSystem, observedFs),
          Effect.provideService(HostProcess.Environment, { PATH: "", SHELL: "/bin/zsh" }),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("unexpected child process")),
          ),
        );
      }),
  );

  it.effect("constructs lazily and load, take and complete never access upstream profiles", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const environment = environmentFor(path, home);
      const profiles = ["T3 Code (Alpha)", "t3code"].map((name) =>
        path.join(environment.appDataDirectory, name, "Local Storage", "leveldb"),
      );
      for (const profile of profiles) {
        yield* fs.makeDirectory(profile, { recursive: true });
        yield* fs.writeFileString(path.join(profile, "sentinel"), "upstream state");
      }
      yield* fs.makeDirectory(environment.stateDir, { recursive: true });
      const accesses: string[] = [];
      const observe = <A, E, R>(target: string, effect: Effect.Effect<A, E, R>) =>
        Effect.sync(() => accesses.push(target)).pipe(Effect.andThen(effect));
      const observedFs = {
        ...fs,
        exists: (target: string) => observe(target, fs.exists(target)),
        readDirectory: (target: string) => observe(target, fs.readDirectory(target)),
        stat: (target: string) => observe(target, fs.stat(target)),
        readFile: (target: string) => observe(target, fs.readFile(target)),
        readFileString: (target: string) => observe(target, fs.readFileString(target)),
        writeFileString: (target: string, content: string) =>
          observe(target, fs.writeFileString(target, content)),
      };

      yield* Effect.gen(function* () {
        const storage = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
        expect(accesses).toEqual([]);
        // These must finish even before load; there is no Deferred startup handshake.
        expect(yield* storage.take).toEqual(Option.none());
        yield* storage.complete;
        yield* storage.load(environment.stateDir);
        expect(yield* storage.take).toEqual(Option.none());
        expect(yield* storage.take).toEqual(Option.none());
        yield* storage.complete;
        yield* storage.load(environment.stateDir);
        yield* storage.complete;
        expect(accesses).toEqual([]);
        expect(yield* fs.exists(path.join(environment.stateDir, "v1-local-storage-imported"))).toBe(
          false,
        );
        for (const profile of profiles) {
          expect(yield* fs.readFileString(path.join(profile, "sentinel"))).toBe("upstream state");
        }
      }).pipe(
        Effect.provide(ForkDesktopLayers.legacyLocalStorageLayer),
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
        Effect.provideService(FileSystem.FileSystem, observedFs),
      );
    }),
  );
});
