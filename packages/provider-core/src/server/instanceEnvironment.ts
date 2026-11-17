import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

export interface ResolvedEnvironmentSecrets {
  readonly source: "secret-reference";
}

// Only the registry records successful vault reads; serialized lookalikes have no authority.
const resolvedEnvironmentSecrets = new WeakMap<
  ResolvedEnvironmentSecrets,
  ReadonlyArray<{ readonly name: string; readonly value: string }>
>();

export function recordResolvedEnvironmentSecrets(
  secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): ResolvedEnvironmentSecrets {
  const provenance = Object.freeze({ source: "secret-reference" as const });
  resolvedEnvironmentSecrets.set(
    provenance,
    Object.freeze(
      secrets.map((secret) => Object.freeze({ name: secret.name, value: secret.value })),
    ),
  );
  return provenance;
}

export function readResolvedEnvironmentSecrets(provenance: ResolvedEnvironmentSecrets | undefined) {
  if (provenance === undefined) return [];
  const secrets = resolvedEnvironmentSecrets.get(provenance);
  if (secrets === undefined) throw new Error("Invalid resolved environment secret provenance.");
  return secrets;
}

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] = expandHomeVariable(name, variable.value, home);
  }
  return next;
});
