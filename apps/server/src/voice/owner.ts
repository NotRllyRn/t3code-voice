import * as Context from "effect/Context";

/** One native Live connection per authenticated app session. */
export const VoiceOwners = Context.Reference<Set<string>>("t3/voice/owner/VoiceOwners", {
  defaultValue: () => new Set(),
});
