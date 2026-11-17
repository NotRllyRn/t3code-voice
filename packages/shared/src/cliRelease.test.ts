import { describe, expect, it } from "vite-plus/test";

import {
  CLI_RELEASES_PAGE_URL,
  cliArchiveTarCommand,
  cliReleaseChannelOf,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("discovers fork releases and classifies strict Voice versions separately", () => {
    expect(CLI_RELEASES_PAGE_URL).toBe("https://github.com/NotRllyRn/t3code-voice/releases");
    expect(cliReleaseIndexPageUrl(2)).toBe(
      "https://api.github.com/repos/NotRllyRn/t3code-voice/releases?per_page=100&page=2",
    );
    expect(cliReleaseChannelOf("0.1.9-voice.1")).toBe("voice");
    expect(cliReleaseChannelOf("0.1.9-voice.01")).toBe("invalid");
    expect(cliReleaseChannelOf("0.1.9-preview.20261116.1")).toBe("preview");
  });

  it("keeps mirror query parameters while adding download paths", () => {
    expect(cliReleaseDownloadBaseUrl("0.1.9-voice.1", "https://mirror.test/releases?sig=abc")).toBe(
      "https://mirror.test/releases/v0.1.9-voice.1?sig=abc",
    );
  });

  it("selects the semver-newest release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-voice.10" },
      { tag_name: "v1.2.4-voice.2" },
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "voice")).toBe("1.2.4-voice.10");
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
