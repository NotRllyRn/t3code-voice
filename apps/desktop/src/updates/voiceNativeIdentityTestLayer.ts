import { Sink, Stream } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

export function voiceNativeIdentityTestLayer(options: {
  readonly nativeIdentityAccepted: boolean;
  readonly nativeBundleShortVersion?: string;
  readonly nativePreventDowngrades?: boolean | string;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(
            ChildProcessSpawner.ExitCode(options.nativeIdentityAccepted ? 0 : 1),
          ),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(
            new TextEncoder().encode(
              JSON.stringify({
                CFBundleShortVersionString: options.nativeBundleShortVersion ?? "0.1.10001",
                ElectronSquirrelPreventDowngrades: options.nativePreventDowngrades ?? true,
              }),
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
}
