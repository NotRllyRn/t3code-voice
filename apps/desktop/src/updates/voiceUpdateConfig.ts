import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { parseVoiceVersion } from "@t3tools/shared/voiceRelease";

export const VOICE_UPDATE_FEED = `${FORK_DESKTOP.releasesUrl}/download/voice-stable/`;
export interface VoiceUpdateConfig {
  readonly track: "voice-stable";
  readonly feedUrl: string;
  readonly publisherSha1: string;
}

export function parseVoiceUpdateConfig(value: unknown, version: string): VoiceUpdateConfig | null {
  if (!parseVoiceVersion(version) || typeof value !== "object" || value === null) return null;
  if (
    !("track" in value) ||
    value.track !== "voice-stable" ||
    !("feedUrl" in value) ||
    value.feedUrl !== VOICE_UPDATE_FEED ||
    !("publisherSha1" in value) ||
    typeof value.publisherSha1 !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.publisherSha1)
  )
    return null;
  return { track: "voice-stable", feedUrl: value.feedUrl, publisherSha1: value.publisherSha1 };
}

export function isVoiceUpdateCandidate(current: string, next: string, channel: string): boolean {
  return (
    channel === "latest" &&
    parseVoiceVersion(current) !== null &&
    parseVoiceVersion(next) !== null &&
    compareSemverVersions(next, current) > 0
  );
}

export function voicePublisherRequirement(publisherSha1: string): string {
  if (!/^[a-f0-9]{40}$/.test(publisherSha1)) throw new Error("Invalid Voice publisher fingerprint");
  return `identifier "${FORK_DESKTOP.appId}" and certificate leaf = H"${publisherSha1}"`;
}
