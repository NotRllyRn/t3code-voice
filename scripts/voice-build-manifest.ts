import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { FORK_RELEASE } from "../packages/shared/src/forkIdentity.ts";
import { parseVoiceVersion } from "../packages/shared/src/voiceRelease.ts";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const sha40 = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const versioned = (version: string) => version.replaceAll(".", "\\.");

export type BuildTarget = "linux-x64" | "mac-arm64";
export interface BuildInput {
  readonly repository: string;
  readonly sourceSha: string;
  readonly version: string;
  readonly target: BuildTarget;
  readonly assets: readonly string[];
  readonly smoke: readonly string[];
  readonly migrationSource: string;
  readonly protocolSource: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function manifestFromFiles(input: BuildInput) {
  assert(input.repository === FORK_RELEASE.repository, "unexpected repository");
  assert(sha40.test(input.sourceSha), "source SHA must be 40 lowercase hex characters");
  assert(
    parseVoiceVersion(input.version)?.upstreamVersion === FORK_RELEASE.upstream.tag.slice(1),
    "unapproved release version",
  );
  assert(
    parseVoiceVersion(input.version)?.revision === FORK_RELEASE.voiceRevision,
    "unapproved Voice revision",
  );
  const linux = input.target === "linux-x64";
  const patterns = linux
    ? [new RegExp(`^t3-${versioned(input.version)}-linux-x64\\.tar\\.gz$`)]
    : [
        new RegExp(`^T3-Code-Voice-${versioned(input.version)}-arm64\\.dmg$`),
        new RegExp(`^T3-Code-Voice-${versioned(input.version)}-arm64\\.zip$`),
      ];
  assert(input.assets.length === patterns.length, "missing or excess release asset");
  const requiredSmoke = linux
    ? ["archive-layout", "cli-version"]
    : ["zip-integrity", "dmg-arch-identity", "packaged-launch"];
  assert(
    input.smoke.length === requiredSmoke.length &&
      requiredSmoke.every((check) => input.smoke.includes(check)),
    "missing build smoke evidence",
  );
  const migrationText = NodeFS.readFileSync(input.migrationSource, "utf8");
  const ids = [...migrationText.matchAll(/^\s*\[(\d+),\s*"[^"]+",\s*Migration\d+\],?\s*$/gm)].map(
    (match) => Number(match[1]),
  );
  assert(ids.length > 0 && ids.every(Number.isSafeInteger), "migration registry not found");
  const databaseMigration = Math.max(...ids);
  const protocolText = NodeFS.readFileSync(input.protocolSource, "utf8");
  const protocolMatch = /^export const ORCHESTRATION_PROTOCOL_VERSION = (\d+);$/m.exec(
    protocolText,
  );
  assert(
    protocolMatch && Number.isSafeInteger(Number(protocolMatch[1])),
    "orchestration protocol registry not found",
  );
  const orchestrationProtocolVersion = Number(protocolMatch[1]);
  const historyCapability =
    /^export const VOICE_HISTORY_CAPABILITY = ["'](voiceHistoryV1)["'];$/m.exec(protocolText)?.[1];
  assert(
    orchestrationProtocolVersion === 3 && historyCapability,
    "Voice history compatibility evidence missing",
  );
  const seen = new Set<string>();
  const artifacts = input.assets.map((filename) => {
    const name = NodePath.basename(filename);
    assert(
      patterns.some((pattern) => pattern.test(name)),
      `unexpected asset: ${name}`,
    );
    assert(!seen.has(name), `duplicate asset: ${name}`);
    seen.add(name);
    const size = NodeFS.statSync(filename).size;
    assert(size > 0, `empty or changed asset: ${name}`);
    const hash = NodeCrypto.createHash("sha256");
    const fd = NodeFS.openSync(filename, "r");
    let read = 0;
    try {
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let count: number;
      while ((count = NodeFS.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        hash.update(chunk.subarray(0, count));
        read += count;
      }
    } finally {
      NodeFS.closeSync(fd);
    }
    assert(read === size && NodeFS.statSync(filename).size === size, `changed asset: ${name}`);
    const digest = hash.digest("hex");
    assert(sha256.test(digest), "invalid digest");
    return {
      platform: linux ? "linux" : "darwin",
      arch: linux ? "x64" : "arm64",
      name,
      sha256: digest,
      size,
      trust: linux ? "unverified" : "experimental-ad-hoc-unnotarized",
    };
  });
  assert(
    patterns.every((pattern) => artifacts.some((artifact) => pattern.test(artifact.name))),
    "missing target asset",
  );
  return {
    schemaVersion: 1,
    version: input.version,
    sourceSha: input.sourceSha,
    upstream: FORK_RELEASE.upstream,
    databaseMigration,
    orchestrationProtocolVersion,
    capabilities: { [historyCapability]: true },
    artifacts,
    smoke: input.smoke,
  };
}

function git(...args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    const [repository, sourceSha, version, target, output, ...assets] = process.argv.slice(2);
    assert(
      repository &&
        sourceSha &&
        version &&
        (target === "linux-x64" || target === "mac-arm64") &&
        output,
      "usage: voice-build-manifest.ts REPO SHA40 VERSION TARGET OUTPUT ASSETS...",
    );
    assert(git("rev-parse", "HEAD") === sourceSha, "source commit mismatch");
    assert(!git("status", "--porcelain", "--untracked-files=no"), "dirty tracked source checkout");
    assert(
      git("merge-base", "--is-ancestor", FORK_RELEASE.upstream.sha, "HEAD") === "",
      "upstream base mismatch",
    );
    for (const filename of [
      "apps/server/package.json",
      "apps/desktop/package.json",
      "apps/web/package.json",
      "packages/contracts/package.json",
    ]) {
      assert(
        JSON.parse(NodeFS.readFileSync(NodePath.resolve(root, filename), "utf8")).version ===
          version,
        `package version mismatch: ${filename}`,
      );
    }
    const smoke = (process.env.VOICE_BUILD_SMOKE ?? "").split(",").filter(Boolean);
    const manifest = manifestFromFiles({
      repository,
      sourceSha,
      version,
      target,
      assets,
      smoke,
      migrationSource: NodePath.resolve(root, "apps/server/src/persistence/Migrations.ts"),
      protocolSource: NodePath.resolve(root, "packages/contracts/src/environment.ts"),
    });
    NodeFS.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    NodeFS.writeFileSync(
      NodePath.resolve(NodePath.dirname(output), "SHA256SUMS"),
      manifest.artifacts.map(({ sha256, name }) => `${sha256}  ${name}\n`).join(""),
      { flag: "wx" },
    );
    console.log(`wrote ${output}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
