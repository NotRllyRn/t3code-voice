import * as Context from "effect/Context";

/** Shared by Live and legacy routes: one voice connection per authenticated app session. */
export const VoiceOwners = Context.Reference<Set<string>>("t3/voice/owner/VoiceOwners", {
  defaultValue: () => new Set(),
});
