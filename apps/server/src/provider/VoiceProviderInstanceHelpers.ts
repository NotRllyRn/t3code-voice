import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ResolvedProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";

import {
  hasStoredEnvironmentSecret,
  readStoredEnvironmentSecrets,
} from "./VoiceStoredEnvironmentSecrets.ts";

export { hasStoredEnvironmentSecret };

export const resolveProviderBlockedReason = (
  entry: ProviderInstanceConfig,
  blockedReason: (driver: ProviderDriverKind) => string | undefined,
): string | undefined =>
  entry.driver === "pi" &&
  typeof entry.config === "object" &&
  entry.config !== null &&
  "environmentMode" in entry.config &&
  entry.config.environmentMode === "clean"
    ? "Clean Pi automation is retired. Configure a new ordinary provider instance explicitly."
    : blockedReason(entry.driver);

export const mergeStoredInstanceSecrets = Effect.fn(
  "ProviderInstanceRegistry.mergeStoredInstanceSecrets",
)(function* <TConfig>(
  instanceId: ProviderInstanceId,
  entry: ProviderInstanceConfig,
  environment: ResolvedProviderInstanceEnvironment,
  config: TConfig,
  unreadable: ReadonlyArray<string> = [],
) {
  const stored = yield* readStoredEnvironmentSecrets(instanceId, entry, environment);
  return {
    secrets: { environment: stored.environment, config },
    unreadable: [...unreadable, ...stored.unreadable],
    storedUnreadable: stored.unreadable.length > 0,
  };
});

export const applySecretReloadDecision = <TSecrets>(
  instanceId: ProviderInstanceId,
  currentSecrets: TSecrets,
  secrets: TSecrets,
  unreadable: ReadonlyArray<string>,
  forceRevokeOnUnreadable: boolean,
  rebuild: Set<ProviderInstanceId>,
  carried: Map<ProviderInstanceId, TSecrets>,
) => {
  // External vault failures keep a working instance; a failed server-store read revokes it.
  if (
    forceRevokeOnUnreadable ||
    (unreadable.length === 0 && !Equal.equals(secrets, currentSecrets))
  ) {
    rebuild.add(instanceId);
    if (unreadable.length === 0) carried.set(instanceId, secrets);
  }
};
