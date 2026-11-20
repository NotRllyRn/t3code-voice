import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

// Only exercise profile selection before the instance lock; no auth or token storage.
vi.mock("@clerk/electron", () => ({
  createClerkBridge: () => {
    throw new Error("must not create a real Clerk bridge");
  },
}));
vi.mock("@clerk/electron/storage", () => ({
  storage: () => {
    throw new Error("must not open Clerk storage");
  },
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

it.effect.each([
  { platform: "darwin", isDevelopment: false },
  { platform: "darwin", isDevelopment: true },
  { platform: "win32", isDevelopment: false },
  { platform: "win32", isDevelopment: true },
  { platform: "linux", isDevelopment: false },
  { platform: "linux", isDevelopment: true },
] as const)("Clerk selects only the fork profile on $platform (dev=$isDevelopment)", (input) =>
  Effect.gen(function* () {
    const paths: Array<[string, string]> = [];
    let quit = false;
    const exit = yield* Effect.exit(
      Effect.scoped(
        DesktopClerk.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodePath.layerPosix,
              FileSystem.layerNoop({
                exists: () => Effect.die("must not probe upstream profiles"),
                readFileString: () => Effect.die("must not read upstream state"),
                writeFileString: () => Effect.die("must not migrate upstream state"),
              }),
              Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
                ...input,
                appDataDirectory: "/isolated/app-data",
              } as DesktopEnvironment.DesktopEnvironment["Service"]),
              Layer.succeed(ElectronApp.ElectronApp, {
                setPath: (name: string, value: string) =>
                  Effect.sync(() => {
                    paths.push([name, value]);
                  }),
                requestSingleInstanceLock: Effect.succeed(false),
                quit: Effect.sync(() => {
                  quit = true;
                }),
              } as unknown as ElectronApp.ElectronApp["Service"]),
              Layer.succeed(
                ElectronShell.ElectronShell,
                {} as ElectronShell.ElectronShell["Service"],
              ),
            ),
          ),
        ),
      ),
    );
    assert.isTrue(Exit.hasInterrupts(exit));
    assert.isTrue(quit);
    assert.deepStrictEqual(paths, [
      [
        "userData",
        input.isDevelopment
          ? "/isolated/app-data/t3code-voice-dev"
          : "/isolated/app-data/t3code-voice",
      ],
    ]);
  }),
);
