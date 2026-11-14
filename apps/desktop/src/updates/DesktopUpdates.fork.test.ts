import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

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
    assert.isFalse(yield* Ref.get((yield* DesktopState.DesktopState).canInstallUpdates));
    assert.equal(harness.checkCount(), 0);
    assert.equal(harness.downloadCount(), 0);
    assert.equal(harness.quitAndInstalls(), 0);
    assert.deepEqual(harness.feedUrls(), []);
  }).pipe(Effect.provide(harness.layer), Effect.scoped);
});
