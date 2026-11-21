import { afterEach, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { FORK_RELEASE } from "../packages/shared/src/forkIdentity.ts";
import { manifestFromFiles } from "./voice-build-manifest.ts";

const upstreamVersion = FORK_RELEASE.upstream.tag.slice(1);
const version = `${upstreamVersion}-voice.${FORK_RELEASE.voiceRevision}`;
const wrongRevision = `${upstreamVersion}-voice.${FORK_RELEASE.voiceRevision + 1}`;
const wrongVersion = `999.0.0-voice.${FORK_RELEASE.voiceRevision}`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-manifest-"));
  dirs.push(dir);
  const migrationSource = NodePath.join(dir, "Migrations.ts");
  const protocolSource = NodePath.join(dir, "environment.ts");
  NodeFS.writeFileSync(
    migrationSource,
    '[81, "Prior", Migration0081],\n  [88, "Voice", Migration0088],\n',
  );
  NodeFS.writeFileSync(
    protocolSource,
    'export const ORCHESTRATION_PROTOCOL_VERSION = 3;\nexport const VOICE_HISTORY_CAPABILITY = "voiceHistoryV1";\n',
  );
  const asset = NodePath.join(dir, `t3-${version}-linux-x64.tar.gz`);
  NodeFS.writeFileSync(asset, "archive bytes");
  return {
    repository: FORK_RELEASE.repository,
    sourceSha: "a".repeat(40),
    version,
    target: "linux-x64" as const,
    assets: [asset],
    smoke: ["archive-layout", "cli-version"],
    migrationSource,
    protocolSource,
  };
}

it("records current migration and protocol registries with checksums of final bytes", () => {
  const input = fixture();
  const result = manifestFromFiles(input);
  expect(result.databaseMigration).toBe(88);
  expect(result.orchestrationProtocolVersion).toBe(3);
  expect(result.capabilities).toEqual({ voiceHistoryV1: true });
  expect(result.artifacts[0]?.sha256).toBe(
    NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(input.assets[0]!)).digest("hex"),
  );
  expect(result.artifacts[0]?.size).toBe(13);
  NodeFS.writeFileSync(input.assets[0]!, "changed bytes");
  expect(manifestFromFiles(input).artifacts[0]?.sha256).not.toBe(result.artifacts[0]?.sha256);
});

it("fails closed for repository, source SHA, version, platform, missing and extra assets", () => {
  const input = fixture();
  expect(() => manifestFromFiles({ ...input, repository: "pingdotgg/t3code" })).toThrow(
    "unexpected repository",
  );
  expect(() => manifestFromFiles({ ...input, sourceSha: "a".repeat(39) })).toThrow("source SHA");
  expect(() => manifestFromFiles({ ...input, version: wrongRevision })).toThrow(
    "Voice revision",
  );
  expect(() => manifestFromFiles({ ...input, version: wrongVersion })).toThrow(
    "release version",
  );
  expect(() => manifestFromFiles({ ...input, target: "mac-arm64" })).toThrow("missing or excess");
  expect(() => manifestFromFiles({ ...input, assets: [] })).toThrow("missing or excess");
  expect(() =>
    manifestFromFiles({ ...input, assets: [input.assets[0]!, input.assets[0]!] }),
  ).toThrow("missing or excess");
  expect(() => manifestFromFiles({ ...input, smoke: [] })).toThrow("smoke evidence");
  NodeFS.writeFileSync(
    input.protocolSource,
    'export const ORCHESTRATION_PROTOCOL_VERSION = 2;\nexport const VOICE_HISTORY_CAPABILITY = "voiceHistoryV1";\n',
  );
  expect(() => manifestFromFiles(input)).toThrow("Voice history compatibility");
  NodeFS.writeFileSync(input.protocolSource, "export const ORCHESTRATION_PROTOCOL_VERSION = 3;\n");
  expect(() => manifestFromFiles(input)).toThrow("Voice history compatibility");
  NodeFS.writeFileSync(
    input.protocolSource,
    'export const ORCHESTRATION_PROTOCOL_VERSION = 3;\nexport const VOICE_HISTORY_CAPABILITY = "voiceHistoryV1";\n',
  );
  NodeFS.writeFileSync(input.assets[0]!, "");
  expect(() => manifestFromFiles(input)).toThrow("empty or changed asset");
});

it("requires both macOS artifacts and exact architecture and version", () => {
  const input = fixture();
  const dmg = NodePath.join(
    input.assets[0]!.replace(/t3-.*$/, ""),
    `T3-Code-Voice-${version}-arm64.dmg`,
  );
  const zip = dmg.replace(/\.dmg$/, ".zip");
  NodeFS.writeFileSync(dmg, "dmg");
  NodeFS.writeFileSync(zip, "zip");
  expect(() => manifestFromFiles({ ...input, target: "mac-arm64", assets: [dmg] })).toThrow(
    "missing or excess",
  );
  const mac = {
    ...input,
    target: "mac-arm64" as const,
    smoke: ["zip-integrity", "dmg-arch-identity", "packaged-launch"],
  };
  expect(manifestFromFiles({ ...mac, assets: [dmg, zip] }).artifacts).toHaveLength(2);
  expect(() =>
    manifestFromFiles({
      ...mac,
      assets: [dmg, zip.replace("arm64", "x64")],
    }),
  ).toThrow("unexpected asset");
  expect(() =>
    manifestFromFiles({
      ...mac,
      assets: [dmg, zip.replace(version, wrongRevision)],
    }),
  ).toThrow("unexpected asset");
});
