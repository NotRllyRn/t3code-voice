import { describe, expect, it } from "vite-plus/test";

import { FORK_DESKTOP, FORK_RELEASE } from "./forkIdentity.ts";
import {
  nextVoiceVersion,
  parseVoiceVersion,
  selectVoiceRelease,
  type VoiceGitHubRelease,
} from "./voiceRelease.ts";

const target = { kind: "desktop-dmg", platform: "darwin", arch: "arm64" } as const;
const name = (version: string) => `T3-Code-Voice-${version}-arm64.dmg`;
const release = (
  version: string,
  overrides: Partial<VoiceGitHubRelease> = {},
): VoiceGitHubRelease => ({
  tag_name: `v${version}`,
  html_url: `https://github.com/NotRllyRn/t3code-voice/releases/tag/v${version}`,
  draft: false,
  prerelease: true,
  assets: [
    {
      name: name(version),
      content_type: "application/octet-stream",
      browser_download_url: `https://github.com/NotRllyRn/t3code-voice/releases/download/v${version}/${name(version)}`,
      digest: `sha256:${"a".repeat(64)}`,
    },
  ],
  ...overrides,
});

describe("Voice release contract", () => {
  it("keeps desktop manual-only and identifies the fork's pinned experimental release", () => {
    expect(FORK_DESKTOP.manualUpdatesOnly).toBe(true);
    expect(FORK_RELEASE).toMatchObject({
      repository: "NotRllyRn/t3code-voice",
      baseBranch: "main",
      upstream: {
        repository: "pingdotgg/t3code",
        tag: "v0.1.11",
        sha: "59651c1761f6c63e9b6056839067066968e6a406",
      },
      voiceRevision: 2,
      githubPrerelease: true,
    });
  });

  it("increments numeric revisions and resets only for a newer upstream", () => {
    expect(nextVoiceVersion("0.1.9")).toBe("0.1.9-voice.1");
    expect(nextVoiceVersion("0.1.9", "0.1.9-voice.9")).toBe("0.1.9-voice.10");
    expect(nextVoiceVersion("0.1.10", "0.1.9-voice.10")).toBe("0.1.10-voice.1");
    expect(nextVoiceVersion("0.1.8", "0.1.9-voice.1")).toBeNull();
    expect(nextVoiceVersion("0.1.9", "0.1.9-preview.20261116.1")).toBeNull();
  });

  it("rejects malformed semver rather than normalizing it", () => {
    for (const version of [
      "v0.1.9-voice.1",
      "0.1.9-voice.0",
      "0.1.9-voice.01",
      "0.1.9-voice.1+meta",
      "00.1.9-voice.1",
      "0.1.9-nightly.1",
      " 0.1.9-voice.1",
      "0.1.9-voice.9007199254740992",
    ]) {
      expect(parseVoiceVersion(version)).toBeNull();
      expect(selectVoiceRelease(version, [release("0.1.9-voice.2")], target).status).toBe(
        "invalid-current",
      );
    }
    expect(parseVoiceVersion("0.1.9-voice.10")).toEqual({ upstreamVersion: "0.1.9", revision: 10 });
    expect(nextVoiceVersion("0.01.9")).toBeNull();
  });

  it("chooses the newest numeric Voice release regardless of list order, including from the one legacy preview", () => {
    const releases = [
      release("0.1.9-voice.9"),
      release("0.1.9-voice.10"),
      release("0.1.9-voice.2"),
    ];
    expect(selectVoiceRelease("0.1.9-preview.20261116.1", releases, target)).toEqual({
      status: "offered",
      version: "0.1.9-voice.10",
      asset: {
        name: name("0.1.9-voice.10"),
        url: `https://github.com/NotRllyRn/t3code-voice/releases/download/v0.1.9-voice.10/${name("0.1.9-voice.10")}`,
        sha256: "a".repeat(64),
      },
    });
    expect(selectVoiceRelease("0.1.9-voice.10", releases, target)).toEqual({
      status: "unavailable",
    });
    expect(selectVoiceRelease("0.1.9-preview.20261117.1", releases, target)).toEqual({
      status: "invalid-current",
    });
  });

  it("ignores drafts, non-prereleases, other channels, missing assets and wrong architecture", () => {
    const wrongArch = release("0.1.9-voice.7").assets[0]!;
    const missingPrerelease = { ...release("0.1.9-voice.10") };
    delete missingPrerelease.prerelease;
    const releases = [
      release("0.1.9-voice.12", { draft: true }),
      release("0.1.9-voice.11", { prerelease: false }),
      missingPrerelease,
      release("0.1.9-nightly.20261116.1"),
      release("0.1.9"),
      release("0.1.9-voice.8", { assets: [] }),
      release("0.1.9-voice.7", {
        assets: [{ ...wrongArch, name: name("0.1.9-voice.7").replace("arm64", "x64") }],
      }),
      release("0.1.9-voice.6"),
    ];
    expect(selectVoiceRelease("0.1.9-voice.5", releases, target)).toMatchObject({
      status: "offered",
      version: "0.1.9-voice.6",
    });
    expect(selectVoiceRelease("0.1.9-voice.6", releases, target)).toEqual({
      status: "unavailable",
    });
  });

  it("offers only compatible CLI archives with canonical checksum assets", () => {
    const version = "0.1.10-voice.6";
    const base = `https://github.com/NotRllyRn/t3code-voice/releases/download/v${version}/`;
    const archive = {
      name: `t3-${version}-linux-x64.tar.gz`,
      content_type: "application/gzip",
      browser_download_url: `${base}t3-${version}-linux-x64.tar.gz`,
    };
    const sums = {
      name: "SHA256SUMS",
      content_type: "text/plain",
      browser_download_url: `${base}SHA256SUMS`,
    };
    const candidate = release(version, { assets: [archive, sums] });
    const cli = { kind: "cli-archive", platform: "linux", arch: "x64" } as const;
    expect(selectVoiceRelease("0.1.10-voice.5", [candidate], cli)).toMatchObject({
      status: "offered",
      version,
      asset: { name: archive.name, url: archive.browser_download_url },
    });
    for (const assets of [
      [archive],
      [sums],
      [archive, { ...sums, browser_download_url: "https://other.test/SHA256SUMS" }],
      [{ ...archive, content_type: "text/html" }, sums],
      [{ ...archive, browser_download_url: `${archive.browser_download_url}?token=x` }, sums],
    ]) {
      expect(selectVoiceRelease("0.1.10-voice.5", [{ ...candidate, assets }], cli)).toEqual({
        status: "unavailable",
      });
    }
    expect(selectVoiceRelease("0.1.10-voice.5", [candidate], { ...cli, arch: "arm64" })).toEqual({
      status: "unavailable",
    });
    expect(
      selectVoiceRelease("0.1.10-voice.5", [candidate], { ...cli, platform: "freebsd" }),
    ).toEqual({ status: "unavailable" });
    expect(selectVoiceRelease(version, [candidate], cli)).toEqual({ status: "unavailable" });
  });

  it("rejects upstream, credentialed, query, traversal and wrong-content-type assets", () => {
    const good = release("0.1.9-voice.2");
    const candidate = good.assets[0]!;
    for (const url of [
      `https://github.com/pingdotgg/t3code/releases/download/v0.1.9-voice.2/${candidate.name}`,
      candidate.browser_download_url.replace("https:", "http:"),
      candidate.browser_download_url.replace("github.com", "user:pass@github.com"),
      `${candidate.browser_download_url}?token=foo`,
      `${candidate.browser_download_url}/../other`,
    ]) {
      expect(
        selectVoiceRelease(
          "0.1.9-voice.1",
          [release("0.1.9-voice.2", { assets: [{ ...candidate, browser_download_url: url }] })],
          target,
        ),
      ).toEqual({ status: "unavailable" });
    }
    expect(
      selectVoiceRelease(
        "0.1.9-voice.1",
        [release("0.1.9-voice.2", { assets: [{ ...candidate, content_type: "text/html" }] })],
        target,
      ),
    ).toEqual({ status: "unavailable" });
    expect(
      selectVoiceRelease(
        "0.1.9-voice.1",
        [{ ...good, html_url: "https://github.com/pingdotgg/t3code/releases/tag/v0.1.9-voice.2" }],
        target,
      ),
    ).toEqual({ status: "unavailable" });
  });
});
