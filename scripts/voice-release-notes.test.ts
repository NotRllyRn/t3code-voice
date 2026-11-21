import { expect, test } from "vite-plus/test";
import { FORK_RELEASE } from "../packages/shared/src/forkIdentity.ts";
import { appendVoiceNotes, loadVoiceNotes } from "./voice-release-notes.ts";

const upstreamVersion = FORK_RELEASE.upstream.tag.slice(1);
const version = `${upstreamVersion}-voice.${FORK_RELEASE.voiceRevision}`;
const wrongRevision = `${upstreamVersion}-voice.${FORK_RELEASE.voiceRevision + 1}`;

const upstream = {
  tag_name: FORK_RELEASE.upstream.tag,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/${FORK_RELEASE.upstream.repository}/releases/tag/${FORK_RELEASE.upstream.tag}`,
  body: "# Upstream highlights\n\nKeep this exact text.\nDo not execute: $(touch /tmp/untrusted)\n",
};
const sha = "a".repeat(40);

test("retains the pinned upstream notes verbatim and appends fork provenance without evaluating release text", async () => {
  const notes = appendVoiceNotes(upstream, version, sha);
  expect(notes.startsWith(upstream.body + "\n\n## Voice Fork\n")).toBe(true);
  expect(notes).toContain("$(touch /tmp/untrusted)");
  expect(notes).toContain(sha);
  expect(notes).toContain(FORK_RELEASE.upstream.sha);
  expect(notes).toContain("experimental and unnotarized");
  for (const changed of [
    { draft: true },
    { prerelease: true },
    { tag_name: "v0.1.9" },
    { html_url: "https://other.test" },
    { body: null },
  ]) {
    expect(() => appendVoiceNotes({ ...upstream, ...changed }, version, sha)).toThrow();
  }
  for (const invalid of [
    upstreamVersion,
    wrongRevision,
    `999.0.0-voice.${FORK_RELEASE.voiceRevision}`,
  ])
    expect(() => appendVoiceNotes(upstream, invalid, sha)).toThrow();
  await expect(
    loadVoiceNotes(version, sha, async (url, init) => {
      expect(url).toBe(
        `https://api.github.com/repos/${FORK_RELEASE.upstream.repository}/releases/tags/${FORK_RELEASE.upstream.tag}`,
      );
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify(upstream));
    }),
  ).resolves.toBe(notes);
  await expect(
    loadVoiceNotes(version, sha, async () => new Response("x".repeat(524_289))),
  ).rejects.toThrow("too large");
  await expect(
    loadVoiceNotes(version, sha, async () => new Response("", { status: 404 })),
  ).rejects.toThrow("HTTP 404");
});
