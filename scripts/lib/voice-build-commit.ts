import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

export class DesktopBuildCommitError extends Schema.TaggedError<DesktopBuildCommitError>()(
  "DesktopBuildCommitError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

export const resolveDesktopBuildCommit = Effect.fn("resolveDesktopBuildCommit")(function* (
  repoRoot: string,
) {
  const configured = yield* Config.String("T3CODE_VOICE_BUILD_COMMIT").pipe(Config.option);
  const explicit = Option.getOrUndefined(configured)?.trim().toLowerCase();
  if (explicit !== undefined && !/^[0-9a-f]{40}$/u.test(explicit)) {
    return yield* new DesktopBuildCommitError({
      reason: "T3CODE_VOICE_BUILD_COMMIT must be a full 40-character source commit SHA.",
    });
  }
  const git = (args: ReadonlyArray<string>) =>
    spawnAndCollectOutput(ChildProcess.make("git", args, { cwd: repoRoot })).pipe(
      Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    );
  const root = yield* git(["rev-parse", "--show-toplevel"]);
  const path = yield* Path.Path;
  if (root.exitCode === 0 && path.resolve(root.stdout.trim()) === path.resolve(repoRoot)) {
    const result = yield* git(["rev-parse", "HEAD"]);
    const hash = result.stdout.trim().toLowerCase();
    const status = yield* git([
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--",
      ".",
      ":(exclude).desktop-build.lock",
    ]);
    if (
      result.exitCode !== 0 ||
      !/^[0-9a-f]{40}$/u.test(hash) ||
      status.exitCode !== 0 ||
      status.stdout.trim()
    ) {
      return yield* new DesktopBuildCommitError({
        reason: "Build T3 Code Voice from a clean committed source snapshot.",
      });
    }
    if (explicit !== undefined && explicit !== hash) {
      return yield* new DesktopBuildCommitError({
        reason: "T3CODE_VOICE_BUILD_COMMIT does not match the source checkout HEAD.",
      });
    }
    return hash;
  }
  if (explicit !== undefined) return explicit;
  return yield* new DesktopBuildCommitError({
    reason:
      "Source commit unavailable. Use a clean Git checkout or set T3CODE_VOICE_BUILD_COMMIT for a separately verified gitless snapshot.",
  });
});
