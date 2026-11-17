import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { parseVoiceVersion } from "@t3tools/shared/voiceRelease";

export const VOICE_UPDATE_FEEDS = {
  "voice-stable": `${FORK_DESKTOP.releasesUrl}/download/voice-stable/`,
  "voice-candidate": `${FORK_DESKTOP.releasesUrl}/download/voice-candidate/`,
} as const;
export const VOICE_UPDATE_FEED = VOICE_UPDATE_FEEDS["voice-stable"];
export interface VoiceUpdateConfig {
  readonly track: keyof typeof VOICE_UPDATE_FEEDS;
  readonly feedUrl: string;
  readonly publisherSha1: string;
}

export function parseVoiceUpdateConfig(value: unknown, version: string): VoiceUpdateConfig | null {
  if (!parseVoiceVersion(version) || typeof value !== "object" || value === null) return null;
  if (
    !("track" in value) ||
    (value.track !== "voice-stable" && value.track !== "voice-candidate") ||
    !("feedUrl" in value) ||
    value.feedUrl !== VOICE_UPDATE_FEEDS[value.track] ||
    !("publisherSha1" in value) ||
    typeof value.publisherSha1 !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.publisherSha1)
  )
    return null;
  return {
    track: value.track,
    feedUrl: VOICE_UPDATE_FEEDS[value.track],
    publisherSha1: value.publisherSha1,
  };
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
