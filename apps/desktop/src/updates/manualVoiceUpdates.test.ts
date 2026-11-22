import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, vi } from "vite-plus/test";
import { FORK_RELEASE } from "@t3tools/shared/forkIdentity";

vi.mock("electron", () => ({}));

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import { checkManualVoiceUpdate, discoverManualVoiceUpdate } from "./manualVoiceUpdates.ts";

const INPUT = {
  currentVersion: "0.1.9-voice.1",
  platform: "darwin",
  arch: "arm64",
  isPackaged: true,
  isDevelopment: false,
};

function release(version = "0.1.9-voice.2") {
  const name = `T3-Code-Voice-${version}-arm64.dmg`;
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/${FORK_RELEASE.repository}/releases/tag/v${version}`,
    draft: false,
    prerelease: FORK_RELEASE.githubPrerelease,
    assets: [
      {
        name,
        browser_download_url: `https://github.com/${FORK_RELEASE.repository}/releases/download/v${version}/${name}`,
        content_type: "application/octet-stream",
      },
    ],
  };
}

function fetcher(body: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
}

describe("manual Voice release discovery", () => {
  it.effect("offers the exact canonical ARM64 asset for Voice and the known legacy tester", () =>
    Effect.gen(function* () {
      for (const currentVersion of [INPUT.currentVersion, "0.1.9-preview.20261116.1"]) {
        const fetchReleases = fetcher([release("0.1.9-voice.10"), release()]);
        const result = yield* discoverManualVoiceUpdate(
          { ...INPUT, currentVersion },
          fetchReleases,
        );
        expect(result).toEqual({
          status: "offered",
          version: "0.1.9-voice.10",
          url: release("0.1.9-voice.10").assets[0]!.browser_download_url,
        });
        expect(fetchReleases).toHaveBeenCalledTimes(1);
        expect(fetchReleases).toHaveBeenCalledWith(
          `https://api.github.com/repos/${FORK_RELEASE.repository}/releases?per_page=100`,
          expect.objectContaining({
            redirect: "error",
            credentials: "omit",
            signal: expect.any(AbortSignal),
          }),
        );
      }
    }),
  );

  it.effect.each([
    { currentVersion: "0.1.9" },
    { currentVersion: "0.1.9-preview.20261117.1" },
    { currentVersion: "bad-version" },
    { arch: "x64" },
    { platform: "linux" },
    { isPackaged: false },
    { isDevelopment: true },
  ])("does not fetch or offer for unsupported installed identity %j", (override) =>
    Effect.gen(function* () {
      const fetchReleases = fetcher([release()]);
      expect(
        (yield* discoverManualVoiceUpdate({ ...INPUT, ...override }, fetchReleases)).status,
      ).toBe("unavailable");
      expect(fetchReleases).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "rejects spoofed, credentialed, tokenized, insecure, and wrong-repository URLs without fallback",
    () =>
      Effect.gen(function* () {
        const valid = release();
        const canonical = valid.assets[0]!.browser_download_url;
        const badUrls = [
          canonical.replace("https:", "http:"),
          canonical.replace("github.com", "github.com.evil.example"),
          canonical.replace("github.com", "user:secret@github.com"),
          canonical.replace(FORK_RELEASE.repository, "pingdotgg/t3code"),
          `${canonical}?token=secret`,
          `${canonical}#fragment`,
          "javascript:alert(1)",
          "not a URL",
        ];
        for (const url of badUrls) {
          const candidate = {
            ...valid,
            assets: [{ ...valid.assets[0]!, browser_download_url: url }],
          };
          const fetchReleases = fetcher([candidate]);
          expect((yield* discoverManualVoiceUpdate(INPUT, fetchReleases)).status).toBe(
            "unavailable",
          );
          expect(fetchReleases).toHaveBeenCalledTimes(1);
        }
        const spoofedRelease = {
          ...valid,
          html_url: valid.html_url.replace(FORK_RELEASE.repository, "pingdotgg/t3code"),
        };
        expect((yield* discoverManualVoiceUpdate(INPUT, fetcher([spoofedRelease]))).status).toBe(
          "unavailable",
        );
      }),
  );

  it.effect(
    "does not confuse absent, equal, older, draft, or wrong-policy assets with an update",
    () =>
      Effect.gen(function* () {
        const valid = release();
        for (const releases of [
          [],
          [release(INPUT.currentVersion)],
          [release("0.1.8-voice.9")],
          [{ ...valid, draft: true }],
          [{ ...valid, prerelease: !FORK_RELEASE.githubPrerelease }],
          [{ ...valid, assets: [] }],
          [
            {
              ...valid,
              assets: [
                { ...valid.assets[0]!, name: valid.assets[0]!.name.replace("arm64", "x64") },
              ],
            },
          ],
          [{ ...valid, tag_name: "v0.1.9-preview.20261117.1" }],
        ]) {
          expect((yield* discoverManualVoiceUpdate(INPUT, fetcher(releases))).status).toBe(
            "unavailable",
          );
        }
      }),
  );

  it.effect.each([403, 429, 404, 500])("reports HTTP %s without any alternate request", (status) =>
    Effect.gen(function* () {
      const fetchReleases = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private response", { status }));
      const result = yield* discoverManualVoiceUpdate(INPUT, fetchReleases);
      expect(result.status).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("private response");
      expect(fetchReleases).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("bounds and validates the response and sanitizes offline errors", () =>
    Effect.gen(function* () {
      for (const body of [
        null,
        {},
        [{ tag_name: "bad" }],
        Array.from({ length: 101 }, () => release()),
      ]) {
        expect((yield* discoverManualVoiceUpdate(INPUT, fetcher(body))).status).toBe("unavailable");
      }
      const oversized = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1)));
      expect((yield* discoverManualVoiceUpdate(INPUT, oversized)).status).toBe("unavailable");
      const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response("not JSON"));
      expect((yield* discoverManualVoiceUpdate(INPUT, malformed)).status).toBe("unavailable");
      const offline = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("secret token and request details"));
      const result = yield* discoverManualVoiceUpdate(INPUT, offline);
      expect(result.status).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(offline).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect.each([false, true])(
    "aborts a stalled check without fallback, reading body=%s",
    (readingBody) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const aborted = vi.fn();
        const stalled = vi.fn<typeof fetch>().mockImplementation((_url, options) => {
          const pending = new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                aborted();
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
          if (!readingBody) {
            Deferred.doneUnsafe(started, Effect.void);
            return pending;
          }
          return Promise.resolve(
            new Response(
              new ReadableStream({
                pull: () => {
                  Deferred.doneUnsafe(started, Effect.void);
                  return pending;
                },
              }),
            ),
          );
        });
        const pending = yield* discoverManualVoiceUpdate(INPUT, stalled).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust(10_000);
        const result = yield* Fiber.join(pending);
        expect(result.status).toBe("unavailable");
        expect(JSON.stringify(result)).toContain("timed out");
        expect(stalled).toHaveBeenCalledTimes(1);
        expect(aborted).toHaveBeenCalledTimes(1);
      }),
  );
});

function runCheck(response: number, policy = DesktopUpdatePolicy.unmanagedUpdatePolicy) {
  const openExternal = vi.fn(() => Effect.succeed(true));
  const showMessageBox = vi.fn(() => Effect.succeed({ response, checkboxChecked: false }));
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: "/Users/tester",
    platform: "darwin",
    processArch: "arm64",
    appVersion: INPUT.currentVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));
  const program = checkManualVoiceUpdate().pipe(
    Effect.provide(
      Layer.mergeAll(
        environment,
        DesktopUpdatePolicy.layerTest(policy),
        Layer.succeed(ElectronDialog.ElectronDialog, {
          showMessageBox,
          pickFolder: () => Effect.succeedNone,
          pickFiles: () => Effect.succeed([]),
          showErrorBox: () => Effect.void,
        }),
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal,
          openSystemSettings: () => Effect.succeed(false),
          copyText: () => Effect.void,
        }),
      ),
    ),
  );
  return { program, openExternal, showMessageBox };
}

it.effect("opens nothing unless the native Download button was explicitly chosen", () =>
  Effect.gen(function* () {
    using request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json([release()]));
    for (const response of [0, 1]) {
      const harness = runCheck(response);
      yield* harness.program;
      expect(harness.showMessageBox).toHaveBeenCalledTimes(1);
      expect(harness.openExternal.mock.calls).toEqual(
        response === 1 ? [[release().assets[0]!.browser_download_url]] : [],
      );
    }
    expect(request).toHaveBeenCalledTimes(2);
  }),
);

it.effect("respects managed restrictions without fetching or opening a URL", () =>
  Effect.gen(function* () {
    using request = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network"));
    for (const policy of [
      { ...DesktopUpdatePolicy.unmanagedUpdatePolicy, mode: "off" as const },
      { ...DesktopUpdatePolicy.unmanagedUpdatePolicy, feedUrl: "https://updates.example.invalid" },
    ]) {
      const harness = runCheck(1, policy);
      yield* harness.program;
      expect(harness.openExternal).not.toHaveBeenCalled();
    }
    expect(request).not.toHaveBeenCalled();
  }),
);
