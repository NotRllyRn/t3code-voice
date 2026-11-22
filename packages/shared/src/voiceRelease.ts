import { FORK_RELEASE } from "./forkIdentity.ts";
import { compareSemverVersions } from "./semver.ts";

const BASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VOICE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-voice\.([1-9]\d*)$/;
const LEGACY_PREVIEW = "0.1.9-preview.20261116.1";

function safeNumbers(segments: ReadonlyArray<string>): boolean {
  return segments.every((part) => Number.isSafeInteger(Number(part)));
}

/** Strict canonical prerelease: no v prefix, metadata, whitespace, or leading zeroes. */
export function parseVoiceVersion(
  version: string,
): { upstreamVersion: string; revision: number } | null {
  const match = VOICE_VERSION.exec(version);
  if (!match || !safeNumbers(match.slice(1))) return null;
  return { upstreamVersion: `${match[1]}.${match[2]}.${match[3]}`, revision: Number(match[4]) };
}

/** Move only forward in upstream version; within one upstream version increment Voice revision. */
export function nextVoiceVersion(upstreamVersion: string, previous?: string): string | null {
  const upstream = BASE_VERSION.exec(upstreamVersion);
  if (!upstream || !safeNumbers(upstream.slice(1))) return null;
  if (previous === undefined) return `${upstreamVersion}-voice.${FORK_RELEASE.voiceRevision}`;
  const prior = parseVoiceVersion(previous);
  if (!prior) return null;
  const comparison = compareSemverVersions(upstreamVersion, prior.upstreamVersion);
  if (comparison < 0) return null;
  if (comparison > 0) return `${upstreamVersion}-voice.${FORK_RELEASE.voiceRevision}`;
  return prior.revision < Number.MAX_SAFE_INTEGER
    ? `${upstreamVersion}-voice.${prior.revision + 1}`
    : null;
}

export interface VoiceGitHubRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  readonly assets: ReadonlyArray<{
    readonly name: string;
    readonly browser_download_url: string;
    readonly content_type: string;
    readonly digest?: string | null;
  }>;
}

export type VoiceReleaseSelection =
  | { readonly status: "invalid-current" | "unavailable" }
  | {
      readonly status: "offered";
      readonly version: string;
      readonly asset: { readonly name: string; readonly url: string; readonly sha256?: string };
    };

/** Caller must fetch releases from the fork's API; release and asset URLs are checked again here. */
export function selectVoiceRelease(
  currentVersion: string,
  releases: ReadonlyArray<VoiceGitHubRelease>,
  target:
    | { readonly kind: "desktop-dmg"; readonly platform: "darwin"; readonly arch: "arm64" }
    | { readonly kind: "cli-archive"; readonly platform: NodeJS.Platform; readonly arch: string },
): VoiceReleaseSelection {
  const current = parseVoiceVersion(currentVersion);
  if (!current && currentVersion !== LEGACY_PREVIEW) return { status: "invalid-current" };

  const platformKey = `${target.platform}-${target.arch}`;
  if (
    target.kind === "cli-archive" &&
    !["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"].includes(platformKey)
  )
    return { status: "unavailable" };

  let best: Extract<VoiceReleaseSelection, { status: "offered" }> | undefined;
  for (const release of releases) {
    if (release.draft || release.prerelease !== FORK_RELEASE.githubPrerelease) continue;
    const version = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : "";
    if (!parseVoiceVersion(version)) continue;
    if (
      release.html_url !== `https://github.com/${FORK_RELEASE.repository}/releases/tag/v${version}`
    )
      continue;
    if (compareSemverVersions(version, currentVersion) <= 0) continue;
    if (best && compareSemverVersions(version, best.version) <= 0) continue;
    const name =
      target.kind === "desktop-dmg"
        ? `T3-Code-Voice-${version}-${target.arch}.dmg`
        : `t3-${version}-${platformKey}.${target.platform === "win32" ? "zip" : "tar.gz"}`;
    const base = `https://github.com/${FORK_RELEASE.repository}/releases/download/v${version}/`;
    const url = `${base}${name}`;
    if (
      target.kind === "cli-archive" &&
      !release.assets.some(
        (candidate) =>
          candidate.name === "SHA256SUMS" &&
          candidate.browser_download_url === `${base}SHA256SUMS` &&
          ["text/plain", "application/octet-stream"].includes(candidate.content_type),
      )
    )
      continue;
    const asset = release.assets.find(
      (candidate) =>
        candidate.name === name &&
        candidate.browser_download_url === url &&
        (candidate.content_type === "application/octet-stream" ||
          (target.kind === "desktop-dmg"
            ? candidate.content_type === "application/x-apple-diskimage"
            : [
                "application/gzip",
                "application/x-gzip",
                "application/zip",
                "application/x-tar",
              ].includes(candidate.content_type))),
    );
    if (!asset) continue;
    const digest = /^sha256:([a-fA-F0-9]{64})$/.exec(asset.digest ?? "")?.[1];
    best = {
      status: "offered",
      version,
      asset: { name, url, ...(digest ? { sha256: digest.toLowerCase() } : {}) },
    };
  }
  return best ?? { status: "unavailable" };
}
