import { LiveVoiceReason } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class LiveConnectionError extends Schema.TaggedError<LiveConnectionError>()(
  "LiveConnectionError",
  { reason: LiveVoiceReason },
) {
  override get message() {
    return "Live connection unavailable.";
  }
}

/** Private instance capability; never included in ServerProvider snapshots. */
export interface ResolvedLiveConnection {
  readonly createUrl: string;
  readonly headers: Redacted.Redacted<Readonly<Record<string, string>>>;
  readonly revision: string;
  readonly protocol: "cpa-codex-live";
  readonly requestedModel: "gpt-live-1.1-codex";
}
export interface LiveConnectionResolver {
  readonly resolveLiveConnection: () => Effect.Effect<ResolvedLiveConnection, LiveConnectionError>;
}
