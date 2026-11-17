import { assert, it } from "@effect/vitest";
import { VOICE_UPDATE_FEED } from "./voiceUpdateConfig.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

it.effect(
  "enables only the baked stable Voice feed after native installed-identity validation",
  () => {
    const harness = makeHarness({
      appVersion: "0.1.10-voice.1",
      nativeIdentityAccepted: true,
      packageJson: JSON.stringify({
        t3VoiceUpdate: {
          track: "voice-stable",
          feedUrl: VOICE_UPDATE_FEED,
          publisherSha1: "a".repeat(40),
        },
      }),
      policy: {
        mode: "auto",
        feedUrl: "https://upstream.invalid",
        allowNightly: true,
        message: null,
      },
    });
    return Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      assert.isTrue((yield* updates.getState).enabled);
      assert.deepEqual(harness.feedUrls(), [{ provider: "generic", url: VOICE_UPDATE_FEED }]);
      assert.equal(harness.updateChannel(), "latest");
      assert.isTrue(harness.allowPrerelease());
      assert.isFalse(harness.allowDowngrade());
      yield* updates.check("manual");
      assert.isAbove(harness.checkCount(), 0);
      assert.equal(harness.downloadCount(), 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  },
);

it.effect.each([
  { nativeIdentityAccepted: false },
  { nativePreventDowngrades: false },
  { nativePreventDowngrades: "true" },
  { nativeBundleShortVersion: "0.1.10002" },
  { nativeBundleShortVersion: "0.1.10-voice.1" },
  { publisherSha1: undefined },
  { track: "nightly" },
  { feedUrl: "https://upstream.invalid" },
  { isPackaged: false },
  { platform: "win32" as const },
])("keeps missing/incompatible/ad-hoc identities manual: %j", (invalid) => {
  const harness = makeHarness({
    appVersion: "0.1.10-voice.1",
    nativeIdentityAccepted: !("nativeIdentityAccepted" in invalid),
    ...("nativePreventDowngrades" in invalid
      ? { nativePreventDowngrades: invalid.nativePreventDowngrades }
      : {}),
    ...("nativeBundleShortVersion" in invalid
      ? { nativeBundleShortVersion: invalid.nativeBundleShortVersion }
      : {}),
    isPackaged: "isPackaged" in invalid ? invalid.isPackaged : undefined,
    platform: "platform" in invalid ? invalid.platform : undefined,
    packageJson: JSON.stringify({
      t3VoiceUpdate: {
        track: "voice-stable",
        feedUrl: VOICE_UPDATE_FEED,
        publisherSha1: "a".repeat(40),
        ...invalid,
      },
    }),
  });
  return Effect.gen(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.configure;
    assert.isFalse((yield* updates.getState).enabled);
    yield* updates.check("manual");
    assert.deepEqual(harness.feedUrls(), []);
    assert.equal(harness.checkCount(), 0);
  }).pipe(Effect.provide(harness.layer), Effect.scoped);
});

it.effect.each([false, true])("keeps mock and managed feeds disabled (managed=%s)", (managed) => {
  const harness = makeHarness({
    policy: {
      mode: "auto",
      feedUrl: managed ? "https://updates.example.com/upstream" : undefined,
      allowNightly: true,
      message: managed ? "Managed updates" : null,
    },
    env: { T3CODE_DESKTOP_MOCK_UPDATES: "true", GITHUB_REPOSITORY: "pingdotgg/t3code" },
  });
  return Effect.gen(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.configure;
    yield* TestClock.adjust("5 hours");
    yield* flushCallbacks;
    yield* updates.check("manual");
    yield* updates.download;
    yield* updates.install;
    yield* updates.installPrepared("9.9.9");
    const initialChannel = (yield* (yield* DesktopAppSettings.DesktopAppSettings).get)
      .updateChannel;
    const state = yield* updates.setChannel("nightly");
    assert.isFalse(state.enabled);
    assert.equal(state.status, "disabled");
    assert.equal(state.message, "Manual updates only for T3 Code Voice testers.");
    assert.deepEqual(yield* updates.disabledReason, Option.some(state.message));
    assert.equal(
      (yield* (yield* DesktopAppSettings.DesktopAppSettings).get).updateChannel,
      initialChannel,
    );
    assert.equal(harness.checkCount(), 0);
    assert.equal(harness.downloadCount(), 0);
    assert.equal(harness.quitAndInstalls(), 0);
    assert.deepEqual(harness.feedUrls(), []);
  }).pipe(Effect.provide(harness.layer), Effect.scoped);
});
