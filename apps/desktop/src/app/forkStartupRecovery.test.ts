import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import { listen, resolveStartupRecoveryOffer } from "./DesktopStartupRecovery.ts";
import { forkStartupRecoveryOffer } from "./forkStartupRecovery.ts";

const updateState = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  ...createInitialDesktopUpdateState(
    "0.1.3",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "latest",
  ),
  enabled: true,
  ...patch,
});

describe("fork startup recovery", () => {
  it("keeps native-identity-gated updates usable in recovery", () => {
    const state = updateState({ status: "downloaded", downloadedVersion: "0.1.10-voice.2" });
    expect(forkStartupRecoveryOffer(state)).toBeUndefined();
    expect(resolveStartupRecoveryOffer(state, "0.1.10-voice.1")).toEqual({
      _tag: "Update",
      version: "0.1.10-voice.2",
    });
  });
  it.each(["available", "downloaded", "checking", "up-to-date", "disabled"] as const)(
    "offers only manual fork releases, never an upstream replacement (%s)",
    (status) => {
      const state = updateState({
        enabled: false,
        status,
        availableVersion: "0.1.4",
        downloadedVersion: "0.1.4",
      });
      // The override deliberately ignores any last-started version.
      for (const lastStartedVersion of ["0.1.2", null]) {
        expect(
          forkStartupRecoveryOffer(state) ?? resolveStartupRecoveryOffer(state, lastStartedVersion),
        ).toEqual({ _tag: "Releases" });
      }
      expect(forkStartupRecoveryOffer(state, true)).toEqual({ _tag: "ManagedPolicy" });
    },
  );
});

it.effect("renders manual recovery and opens fork releases with a retained upstream download", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const checked = yield* Deferred.make<void>();
      const opened = yield* Deferred.make<string>();
      const loaded: string[] = [];
      let navigate: ((event: { preventDefault: () => void }, url: string) => void) | undefined;
      const recovery = {
        isDestroyed: () => false,
        loadURL: (url: string) => {
          loaded.push(decodeURIComponent(url));
          return Promise.resolve();
        },
        once: () => {},
        webContents: {
          setWindowOpenHandler: () => {},
          on: (_event: string, listener: typeof navigate) => {
            navigate = listener;
          },
        },
      } as unknown as Electron.BrowserWindow;
      const state = yield* DesktopState.DesktopState;
      yield* listen.pipe(
        Effect.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({ readFileString: () => Effect.succeed("0.1.2") }),
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              appVersion: "0.1.3",
              stateDir: "/task/state",
              logDir: "/task/logs",
              path: { join: (...parts: string[]) => parts.join("/") },
            } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
            Layer.succeed(ElectronApp.ElectronApp, {
              on: () => Effect.void,
            } as unknown as ElectronApp.ElectronApp["Service"]),
            Layer.succeed(ElectronShell.ElectronShell, {
              openExternal: (url: string) => Deferred.succeed(opened, url).pipe(Effect.asVoid),
            } as unknown as ElectronShell.ElectronShell["Service"]),
            Layer.succeed(ElectronTheme.ElectronTheme, {
              shouldUseDarkColors: Effect.succeed(false),
            } as ElectronTheme.ElectronTheme["Service"]),
            Layer.succeed(ElectronWindow.ElectronWindow, {
              main: Effect.succeedNone,
              create: () => Effect.succeed(recovery),
            } as unknown as ElectronWindow.ElectronWindow["Service"]),
            Layer.succeed(DesktopUpdates.DesktopUpdates, {
              subscribe: Effect.succeed({
                latest: updateState({
                  enabled: false,
                  status: "downloaded",
                  downloadedVersion: "0.1.4",
                }),
                changes: Stream.empty,
              }),
              check: () => Deferred.succeed(checked, undefined),
              getState: Effect.die("manual recovery must not read an install candidate"),
              download: Effect.die("manual recovery must not download an update"),
              installPrepared: () => Effect.die("manual recovery must not install an update"),
            } as unknown as DesktopUpdates.DesktopUpdates["Service"]),
          ),
        ),
      );
      yield* SubscriptionRef.set(state.primaryBackendStartup, {
        _tag: "Failing",
        reason: "Server failed before readiness",
        managedPolicy: false,
        output: "Failure details",
      });
      yield* Deferred.await(checked);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toContain(
        "Manual updates only for T3 Code Voice testers. Get a tester from the fork&#39;s releases page.",
      );
      expect(loaded[0]).toContain('href="https://startup-recovery.invalid/releases"');
      expect(loaded[0]).not.toContain('href="https://startup-recovery.invalid/update"');
      expect(loaded[0]).not.toContain('href="https://startup-recovery.invalid/reinstall"');
      navigate!({ preventDefault: () => {} }, "https://startup-recovery.invalid/releases");
      expect(yield* Deferred.await(opened)).toBe(
        "https://github.com/NotRllyRn/t3code-voice/releases",
      );
    }),
  ).pipe(Effect.provide(DesktopState.layer)),
);
