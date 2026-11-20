import { parseVoiceVersion } from "@t3tools/shared/voiceRelease";
import { compareExactServiceVersions } from "./serviceProtocol.ts";

export function voiceServerUpdateRefusal(input: {
  readonly serverVersion: string;
  readonly targetVersion: string;
  readonly channel?: string;
}): string | null {
  if (parseVoiceVersion(input.serverVersion) === null) return null;
  if (input.channel !== undefined) {
    return "Voice servers cannot switch to upstream release channels; update to a Voice release instead.";
  }
  if (parseVoiceVersion(input.targetVersion) === null) {
    return `Voice servers can update only to Voice releases; refusing t3@${input.targetVersion}.`;
  }
  return compareExactServiceVersions(input.targetVersion, input.serverVersion) <= 0
    ? `Voice updates require a newer release than ${input.serverVersion}.`
    : null;
}
