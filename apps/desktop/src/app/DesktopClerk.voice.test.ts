import * as NodePathLayer from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

const layerDesktopClerk = (listeners: Map<string, (...args: unknown[]) => void>) =>
  DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePathLayer.layerPosix,
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          stateDir: "/tmp/t3-desktop-clerk-voice",
          isDevelopment: true,
          appDataDirectory: "/tmp/app-data",
          platform: "darwin",
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.succeed(ElectronApp.ElectronApp, {
          setPath: () => Effect.void,
          requestSingleInstanceLock: Effect.succeed(true),
          quit: Effect.void,
          on: (name: string, listener: (...args: unknown[]) => void) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                listeners.set(name, listener);
              }),
              () =>
                Effect.sync(() => {
                  listeners.delete(name);
                }),
            ).pipe(Effect.asVoid),
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: () => Effect.succeed(true),
          openSystemSettings: () => Effect.succeed(false),
          copyText: () => Effect.void,
        }),
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      ),
    ),
  );

it.effect("ignores upstream t3code:// and t3code-dev:// deep links and app links", () =>
  Effect.gen(function* () {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const loadURL = vi.fn(async (_url: string) => undefined);
    const received: Array<string> = [];
    const electronApp = {
      whenReady: Effect.void,
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      currentMainOrFirst: Effect.succeedSome({ loadURL }),
      reveal: () => Effect.void,
    } as unknown as ElectronWindow.ElectronWindow["Service"];

    yield* Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const open = (url: string) => {
        const event = { preventDefault: vi.fn() };
        listeners.get("open-url")!(event, url);
        return event.preventDefault.mock.calls.length;
      };
      for (const scheme of ["t3code", "t3code-dev"]) {
        assert.strictEqual(open(`${scheme}://app/settings/providers?instanceId=work`), 0);
        assert.strictEqual(open(`${scheme}://new?prompt=hi`), 0);
        assert.strictEqual(open(`${scheme}://threads/env-1/thread-1`), 0);
        assert.strictEqual(
          open(`${scheme}://pair?pairingUrl=https%3A%2F%2Fvps.example.com%2F%23token%3Dabc`),
          0,
        );
      }
      yield* Effect.yieldNow;
      assert.equal(loadURL.mock.calls.length, 0);
      assert.deepStrictEqual(received, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopClerk(listeners)),
      Effect.provideService(HostProcess.Arguments, ["t3"]),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url) => Effect.sync(() => void received.push(url)),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  }),
);
