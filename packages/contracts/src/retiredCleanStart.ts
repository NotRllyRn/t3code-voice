import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// Retained only to decode and reject retired automation in persisted history.
export const ProviderCleanStartConstraint = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: Schema.Literal("pi"),
  environmentMode: Schema.Literal("clean"),
});
export type ProviderCleanStartConstraint = typeof ProviderCleanStartConstraint.Type;

export const RetiredApprovedBase = Schema.Struct({
  branch: TrimmedNonEmptyString,
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
});
