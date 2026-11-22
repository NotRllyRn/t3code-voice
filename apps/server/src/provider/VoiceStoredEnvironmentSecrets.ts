import type {
  ProviderInstanceConfig,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ResolvedProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const isStoredEnvironmentSecret = (variable: ProviderInstanceEnvironment[number]) =>
  variable.name === "OPENAI_API_KEY" &&
  typeof variable.value === "string" &&
  variable.sensitive === true &&
  variable.valueRedacted === true;

export const hasStoredEnvironmentSecret = (entry: ProviderInstanceConfig) =>
  entry.environment?.some(isStoredEnvironmentSecret) === true;

export const readStoredEnvironmentSecrets = Effect.fn(
  "ProviderInstanceRegistry.readStoredEnvironmentSecrets",
)(function* (
  instanceId: ProviderInstanceId,
  entry: ProviderInstanceConfig,
  environment: ResolvedProviderInstanceEnvironment,
) {
  const unreadable: string[] = [];
  const resolved = yield* Effect.forEach(environment, (variable, index) =>
    Effect.gen(function* () {
      const source = entry.environment?.[index];
      if (source === undefined || !isStoredEnvironmentSecret(source)) return variable;
      const store = yield* ServerSecretStore.ServerSecretStore;
      const slot = `provider-env-${Buffer.from(instanceId, "utf8").toString("base64url")}-${Buffer.from(source.name, "utf8").toString("base64url")}`;
      const bytes = yield* store.get(slot).pipe(Effect.catch(() => Effect.succeedNone));
      const value = Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : "";
      if (value.trim() === "") unreadable.push(source.name);
      return { ...variable, value };
    }),
  );
  return { environment: resolved, unreadable };
});
