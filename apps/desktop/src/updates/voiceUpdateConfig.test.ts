import { describe, expect, it } from "@effect/vitest";
import {
  isVoiceUpdateCandidate,
  parseVoiceUpdateConfig,
  VOICE_UPDATE_FEED,
} from "./voiceUpdateConfig.ts";

const config = {
  track: "voice-stable",
  feedUrl: "https://github.com/NotRllyRn/t3code-voice/releases/download/voice-stable/",
  publisherSha1: "a".repeat(40),
};

describe("Voice stable update boundary", () => {
  it("requires an explicit fork feed, track, identity and Voice version", () => {
    expect(parseVoiceUpdateConfig(config, "0.1.10-voice.1")?.feedUrl).toBe(VOICE_UPDATE_FEED);
    const candidate = {
      ...config,
      track: "voice-candidate",
      feedUrl: "https://github.com/NotRllyRn/t3code-voice/releases/download/voice-candidate/",
    };
    expect(parseVoiceUpdateConfig(candidate, "0.1.10-voice.1")).toEqual(candidate);
    for (const invalid of [
      { ...candidate, feedUrl: config.feedUrl },
      { ...config, feedUrl: candidate.feedUrl },
      { ...candidate, feedUrl: candidate.feedUrl.replace("NotRllyRn", "someone") },
      { ...candidate, feedUrl: "http://127.0.0.1:18973/good/" },
      { ...candidate, feedUrl: "https://example.com/voice-candidate/" },
      { ...candidate, feedUrl: `${candidate.feedUrl}?override=1` },
      { ...candidate, track: "voice-candidate-20261117" },
      undefined,
      {},
      { ...config, publisherSha1: "-" },
      { ...config, publisherSha1: undefined },
      { ...config, track: "nightly" },
      { ...config, feedUrl: "https://github.com/pingdotgg/t3code/releases/latest/download/" },
      { ...config, feedUrl: `${config.feedUrl}?override=1` },
    ]) {
      expect(parseVoiceUpdateConfig(invalid, "0.1.10-voice.1")).toBeNull();
    }
    for (const version of [
      "0.1.10",
      "0.1.10-nightly.20261117.1",
      "0.1.10-voice.01",
      "0.1.10-voice.1+dev",
    ]) {
      expect(parseVoiceUpdateConfig(config, version)).toBeNull();
    }
  });
  it("offers only strictly newer Voice revisions or upstream bases on stable", () => {
    for (const next of ["0.1.10-voice.2", "0.1.11-voice.1", "0.2.0-voice.1"]) {
      expect(isVoiceUpdateCandidate("0.1.10-voice.1", next, "latest")).toBe(true);
    }
    for (const next of [
      "0.1.10-voice.1",
      "0.1.9-voice.99",
      "0.1.10",
      "0.1.11-nightly.20261117.1",
      "0.1.11-voice.0",
      "0.1.11-voice.01",
    ]) {
      expect(isVoiceUpdateCandidate("0.1.10-voice.1", next, "latest")).toBe(false);
    }
    expect(isVoiceUpdateCandidate("0.1.10-voice.1", "0.1.10-voice.2", "nightly")).toBe(false);
    expect(isVoiceUpdateCandidate("0.1.10-voice.2", "0.1.10-voice.1", "latest")).toBe(false);
  });
});
