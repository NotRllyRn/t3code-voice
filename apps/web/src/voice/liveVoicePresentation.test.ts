import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { INITIAL_LIVE_VOICE_STATE } from "@t3tools/client-runtime/voice-conversation";
import { expect, it } from "vite-plus/test";
import { liveVoiceTargetIsViewed, matchesLiveVoiceTarget } from "./liveVoicePresentation";

it("keeps draft ownership through early binding and scopes the promoted thread to its environment", () => {
  const environmentId = EnvironmentId.make("local");
  const target = { environmentId, draftId: "draft / one" };
  const voice = { ...INITIAL_LIVE_VOICE_STATE, threadId: ThreadId.make("new / thread") };
  expect(matchesLiveVoiceTarget(target, INITIAL_LIVE_VOICE_STATE, target)).toBe(true);
  expect(matchesLiveVoiceTarget(target, voice, target)).toBe(true);
  expect(matchesLiveVoiceTarget(target, voice, { environmentId, threadId: voice.threadId })).toBe(
    true,
  );
  expect(
    matchesLiveVoiceTarget(target, voice, {
      environmentId: EnvironmentId.make("remote"),
      threadId: voice.threadId,
    }),
  ).toBe(false);
  expect(matchesLiveVoiceTarget(target, voice, { environmentId, draftId: "another" })).toBe(false);
  expect(liveVoiceTargetIsViewed(target, voice, "/draft/draft%20%2F%20one")).toBe(true);
  expect(liveVoiceTargetIsViewed(target, voice, "/local/new%20%2F%20thread")).toBe(true);
  for (const pathname of [
    "/settings/voice",
    "/usage",
    "/threads",
    "/remote/new%20%2F%20thread",
    "/local/other",
  ]) {
    expect(liveVoiceTargetIsViewed(target, voice, pathname)).toBe(false);
  }
});
