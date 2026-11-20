// @effect-diagnostics nodeBuiltinImport:off -- Exercise the synchronous preflight against byte-for-byte SQLite snapshots.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { FORK_RELEASE } from "@t3tools/shared/forkIdentity";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import { migrationManifest } from "../persistence/Migrations.ts";
import * as NpmRelease from "./npmRelease.ts";
import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import { voiceServerUpdateRefusal } from "./selfUpdate.ts";

function release(version: string) {
  const base = `https://github.com/${FORK_RELEASE.repository}/releases`;
  return {
    tag_name: `v${version}`,
    html_url: `${base}/tag/v${version}`,
    prerelease: true,
    assets: [`t3-${version}-linux-x64.tar.gz`, "SHA256SUMS"].map((name) => ({
      name,
      browser_download_url: `${base}/download/v${version}/${name}`,
      content_type: "application/octet-stream",
    })),
  };
}

it.effect(
  "selects Voice revision 10 over 2 regardless of index order and agrees with the update gate",
  () =>
    Effect.gen(function* () {
      for (const versions of [
        ["0.1.10-voice.2", "0.1.10-voice.10"],
        ["0.1.10-voice.10", "0.1.10-voice.2"],
      ]) {
        const requested: string[] = [];
        const service = yield* NpmRelease.make("0.1.10-voice.1").pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: () => Effect.die("Voice discovery must never execute npm"),
          }),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Architecture, "x64"),
          Effect.provide(NodeServices.layer),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requested.push(request.url);
              // An invalid leading-zero revision must not outrank canonical releases.
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      ...versions.map(release),
                      release("0.1.10-voice.03"),
                      release("0.1.10-voice.099"),
                    ]),
                  ),
                ),
              );
            }),
          ),
        );
        const selected = yield* service.get({ spec: "voice" });
        expect(selected).toEqual({ version: "0.1.10-voice.10" });
        expect(requested).toEqual([
          `https://api.github.com/repos/${FORK_RELEASE.repository}/releases?per_page=100&page=1`,
        ]);
        expect(
          voiceServerUpdateRefusal({
            serverVersion: "0.1.10-voice.2",
            targetVersion: selected!.version,
          }),
        ).toBeNull();
        expect(
          voiceServerUpdateRefusal({
            serverVersion: selected!.version,
            targetVersion: "0.1.10-voice.2",
          }),
        ).not.toBeNull();
      }
    }),
);

it.effect(
  "offers no upstream substitute when every newer fork candidate is invalid or lacks the host archive",
  () =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const invalid = release("0.1.10-voice.03");
      const wrongArch = release("0.1.10-voice.10");
      wrongArch.assets = wrongArch.assets.map((asset) => ({
        ...asset,
        name: asset.name.replace("linux-x64", "linux-arm64"),
        browser_download_url: asset.browser_download_url.replace("linux-x64", "linux-arm64"),
      }));
      const service = yield* NpmRelease.make("0.1.10-voice.2").pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die("unexpected npm fallback"),
        }),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requested.push(request.url);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify([invalid, wrongArch])),
              ),
            );
          }),
        ),
      );
      expect(yield* service.get({ spec: "voice" })).toBeNull();
      expect(requested).toEqual([
        `https://api.github.com/repos/${FORK_RELEASE.repository}/releases?per_page=100&page=1`,
      ]);
      expect(
        voiceServerUpdateRefusal({
          serverVersion: "0.1.10-voice.2",
          targetVersion: "0.1.10-voice.03",
        }),
      ).not.toBeNull();
    }),
);

it("preflights archived data read-only, including a rejected newer schema, without creating a missing database", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-upgrade-regression-"));
  try {
    const databasePath = NodePath.join(root, "archived.sqlite");
    const db = new NodeSqlite.DatabaseSync(databasePath);
    try {
      db.exec(
        "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE archived_messages (body TEXT);",
      );
      db.prepare("INSERT INTO archived_messages VALUES (?)").run(
        "synthetic archived message: café 🗂",
      );
      const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest) insert.run(id, name);
    } finally {
      db.close();
    }
    const check = () =>
      runServicePreflight({
        databasePath,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "0.1.10-voice.10",
      });
    const before = NodeFS.readFileSync(databasePath);
    expect(check().status).toBe("ready");
    expect(NodeFS.readFileSync(databasePath)).toEqual(before);
    const newer = new NodeSqlite.DatabaseSync(databasePath);
    try {
      newer
        .prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)")
        .run(Math.max(...migrationManifest.map(([id]) => id)) + 1, "SyntheticFutureSchema");
    } finally {
      newer.close();
    }
    const future = NodeFS.readFileSync(databasePath);
    const blocked = check();
    expect(blocked.status).toBe("blocked");
    expect(blocked.status === "blocked" && blocked.reason).toContain("SyntheticFutureSchema");
    expect(NodeFS.readFileSync(databasePath)).toEqual(future);
    const missing = NodePath.join(root, "missing.sqlite");
    expect(
      runServicePreflight({
        databasePath: missing,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "0.1.10-voice.10",
      }).status,
    ).toBe("ready");
    expect(NodeFS.readdirSync(root)).toEqual(["archived.sqlite"]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
