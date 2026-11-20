import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

it.effect("rejects a queued clean start when the current adapter driver no longer matches", () => {
  let openCount = 0;
  const instanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const providerSessionId = ProviderSessionId.make("clean-queued-session");
  const adapter = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => {
      openCount += 1;
      return Effect.fail(
        new ProviderAdapter.ProviderAdapterOpenSessionError({ driver, providerSessionId }),
      );
    },
  } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
  return Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const result = yield* manager
      .open({
        threadId: ThreadId.make("clean-queued-thread"),
        providerSessionId,
        modelSelection: { instanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          cleanProviderConstraint: { instanceId, driver: "pi", environmentMode: "clean" },
        },
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(openCount, 0);
    assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name: "session-retirement" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      ),
    ),
  );
});
