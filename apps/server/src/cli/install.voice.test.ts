import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import { installCli } from "./install.ts";

const VERSION = packageJson.version;

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-install-voice-" });
  const runtimeDir = path.join(root, FORK_DESKTOP.homeDirectoryName, "runtime");
  const executable = path.join(runtimeDir, "versions", VERSION, "t3");
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fs.writeFileString(executable, "");
  const binDir = path.join(root, "bin");
  yield* fs.makeDirectory(binDir, { recursive: true });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>, env: NodeJS.ProcessEnv = {}) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.HomeDirectory, root),
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provideService(HostProcess.ExecutablePath, executable),
      Effect.provideService(HostProcess.Environment, {
        PATH: "/usr/bin",
        SHELL: "/bin/zsh",
        T3CODE_INSTALL_BIN_DIR: binDir,
        ...env,
      }),
    );
  return { root, runtimeDir, link: path.join(binDir, "t3"), provide };
});

it.layer(NodeServices.layer)("t3 install Voice", (it) => {
  it.effect("refuses to overwrite upstream .t3 launchers and avoids npx guidance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, runtimeDir, link, provide } = yield* setup;

      for (const upstreamPath of [".t3/bin/t3", ".t3/runtime/versions/0.0.1/t3"]) {
        const upstream = path.join(root, upstreamPath);
        yield* fs.symlink(upstream, link);
        const foreign = yield* provide(installCli()).pipe(Effect.flip);
        assert.include(foreign.message, "Another t3 is already at");
        assert.equal(yield* fs.readLink(link), upstream);
        yield* fs.remove(link);
      }

      const unrunnable = yield* provide(
        installCli().pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(
            HostProcess.ExecutablePath,
            path.join(runtimeDir, "versions/100%/t3"),
          ),
        ),
      ).pipe(Effect.flip);
      assert.include(unrunnable.message, "has % or non-ASCII characters");
      assert.notInclude(unrunnable.message, "npx");
    }).pipe(Effect.scoped),
  );

  it.effect("gives non-bundled installs fork release guidance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { link, provide } = yield* setup;
      const error = yield* provide(
        installCli().pipe(Effect.provideService(HostProcess.IsExecutable, false)),
      ).pipe(Effect.flip);
      assert.include(error.message, FORK_DESKTOP.releasesUrl);
      assert.notInclude(error.message, "t3.codes/install");
      assert.notInclude(error.message, "npx t3");
      assert.isFalse(yield* fs.exists(link));
    }).pipe(Effect.scoped),
  );
});
