import { expect, test } from "vitest";
import { appendVoiceNotes, loadVoiceNotes } from "./voice-release-notes.ts";

const upstream = {
  tag_name: "v0.1.9",
  draft: false,
  prerelease: false,
  html_url: "https://github.com/pingdotgg/t3code/releases/tag/v0.1.9",
  body: "# Upstream highlights\n\nKeep this exact text.\nDo not execute: $(touch /tmp/untrusted)\n",
};
const version = "0.1.9-voice.1";
const sha = "a".repeat(40);

test("retains the pinned upstream notes verbatim and appends fork provenance without evaluating release text", async () => {
  const notes = appendVoiceNotes(upstream, version, sha);
  expect(notes.startsWith(upstream.body + "\n\n## Voice Fork\n")).toBe(true);
  expect(notes).toContain("$(touch /tmp/untrusted)");
  expect(notes).toContain(sha);
  expect(notes).toContain("experimental and unnotarized");
  for (const changed of [
    { draft: true },
    { prerelease: true },
    { tag_name: "v0.1.10" },
    { html_url: "https://other.test" },
    { body: null },
  ]) {
    expect(() => appendVoiceNotes({ ...upstream, ...changed }, version, sha)).toThrow();
  }
  for (const invalid of ["0.1.9", "0.1.9-voice.2", "0.1.10-voice.1"])
    expect(() => appendVoiceNotes(upstream, invalid, sha)).toThrow();
  await expect(
    loadVoiceNotes(version, sha, async (url, init) => {
      expect(url).toBe("https://api.github.com/repos/pingdotgg/t3code/releases/tags/v0.1.9");
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
