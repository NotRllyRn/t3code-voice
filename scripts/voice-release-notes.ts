import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { FORK_RELEASE } from "../packages/shared/src/forkIdentity.ts";
import { parseVoiceVersion } from "../packages/shared/src/voiceRelease.ts";

export function appendVoiceNotes(release: unknown, version: string, sourceSha: string): string {
  if (!release || typeof release !== "object" || Array.isArray(release))
    throw new Error("Invalid upstream release");
  const value = release as Record<string, unknown>;
  const parsed = parseVoiceVersion(version);
  if (
    !parsed ||
    parsed.upstreamVersion !== FORK_RELEASE.upstream.tag.slice(1) ||
    parsed.revision !== FORK_RELEASE.voiceRevision ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    value.tag_name !== FORK_RELEASE.upstream.tag ||
    value.draft !== false ||
    value.prerelease !== false ||
    value.html_url !==
      `https://github.com/${FORK_RELEASE.upstream.repository}/releases/tag/${FORK_RELEASE.upstream.tag}` ||
    typeof value.body !== "string" ||
    value.body.length === 0
  )
    throw new Error("Upstream notes do not match the pinned release");
  return (
    value.body +
    `\n\n## Voice Fork\n\nExperimental Voice build \`${version}\`, from fork commit \`${sourceSha}\`.\n\n` +
    `Upstream base: [${FORK_RELEASE.upstream.tag}](https://github.com/${FORK_RELEASE.upstream.repository}/releases/tag/${FORK_RELEASE.upstream.tag}) (\`${FORK_RELEASE.upstream.sha}\`).\n\n` +
    `[Voice changes](https://github.com/${FORK_RELEASE.repository}/compare/${FORK_RELEASE.upstream.sha}...${sourceSha}). See \`voice-release.json\` and \`SHA256SUMS\` for artifact provenance and checksums.\n\n` +
    "Build-only evidence, not a published update. macOS ad-hoc artifacts are experimental and unnotarized; use the manual trust path. A checksum is not a signing or update-install proof.\n"
  );
}

export async function loadVoiceNotes(
  version: string,
  sourceSha: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const url = `https://api.github.com/repos/${FORK_RELEASE.upstream.repository}/releases/tags/${FORK_RELEASE.upstream.tag}`;
  const response = await fetcher(url, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(8_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Upstream notes HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty upstream notes response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 524_288) throw new Error("Upstream notes response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return appendVoiceNotes(JSON.parse(Buffer.concat(chunks).toString("utf8")), version, sourceSha);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [version, sourceSha, output, ...extra] = process.argv.slice(2);
  if (!version || !sourceSha || !output || extra.length)
    throw new Error("Usage: voice-release-notes.ts VERSION SHA40 OUTPUT");
  await NodeFSP.writeFile(output, await loadVoiceNotes(version, sourceSha), { flag: "wx" });
}
