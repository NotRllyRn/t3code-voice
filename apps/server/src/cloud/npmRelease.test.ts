import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as NpmRelease from "./npmRelease.ts";
import { FORK_RELEASE } from "@t3tools/shared/forkIdentity";

const version = "0.1.5-nightly.20261030.1";
const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const noPublicRegistry = HttpClient.make(() =>
  Effect.die("a configured npm lookup must not fall back to public npm"),
);
// A fake npm on PATH decides whether npm counts as installed.
const makeService = Effect.fnUntraced(function* (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  publicRegistry: HttpClient.HttpClient = noPublicRegistry,
  npmInstalled = true,
  runtimeVersion = version,
  environment: NodeJS.ProcessEnv = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const npmBin = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-release-" });
  for (const name of ["npm", "npm.cmd"]) {
    yield* fs.writeFileString(path.join(npmBin, name), "", { mode: 0o755 });
  }
  return yield* NpmRelease.make(runtimeVersion).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    Effect.provideService(HttpClient.HttpClient, publicRegistry),
    Effect.provideService(HostProcess.Environment, {
      PATH: npmInstalled ? npmBin : "",
      PATHEXT: ".CMD",
      ...environment,
    }),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
  );
}, Effect.provide(NodeServices.layer));

it.effect.each([
  {
    spec: version,
    stdout: JSON.stringify({ version, t3code: { databaseMigration: 42 } }),
    migration: 42,
  },
  {
    spec: "nightly",
    stdout: JSON.stringify([{ version, t3code: { databaseMigration: 42 } }]),
    migration: 42,
  },
  { spec: "latest", stdout: JSON.stringify(version), migration: undefined },
])("reads $spec through npm and retains migration compatibility metadata", (fixture) =>
  Effect.gen(function* () {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const service = yield* makeService((input) => {
      calls.push(input);
      return Effect.succeed(output(fixture.stdout));
    });
    const expected = {
      version,
      ...(fixture.migration === undefined ? {} : { databaseMigration: fixture.migration }),
    };
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: expect.stringMatching(/[/\\]npm(?:\.cmd)?$/i),
      args: ["view", "--global", "--json", `t3@${fixture.spec}`, "version", "t3code"],
      maxOutputBytes: 256 * 1024,
    });
    yield* TestClock.adjust("1 minute");
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(calls).toHaveLength(2);
  }),
);

it.effect("rejects an invalid fixture before any request and never falls back", () =>
  Effect.gen(function* () {
    const service = yield* makeService(
      () => Effect.die("unexpected npm"),
      HttpClient.make(() => Effect.die("invalid fixture must not make requests")),
      true,
      "0.1.10-voice.5",
      { T3CODE_VOICE_RELEASE_TEST_INDEX_URL: "https://example.com/index" },
    );
    expect((yield* service.get({ spec: "voice" }).pipe(Effect.flip)).reason).toContain(
      "Invalid loopback",
    );
  }),
);

it.effect.each([
  { body: "not-json", status: 200 },
  { body: JSON.stringify({ tag_name: "v0.1.10-voice.6" }), status: 200 },
  { body: "[]", status: 500 },
  { body: "[]", status: 302 },
  { body: " ".repeat(8 * 1024 * 1024 + 1), status: 200 },
])("fails closed on unavailable or malformed Voice metadata ($status)", ({ body, status }) =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService(
      () => Effect.die("unexpected npm"),
      HttpClient.make((request) => {
        urls.push(request.url);
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));
      }),
      true,
      "0.1.10-voice.5",
      { T3CODE_VOICE_RELEASE_TEST_INDEX_URL: "http://127.0.0.1:12345/index" },
    );
    expect(yield* service.get({ spec: "voice" }).pipe(Effect.flip)).toBeInstanceOf(
      ServerNpmReleaseError,
    );
    expect(urls).toEqual(["http://127.0.0.1:12345/index?per_page=100&page=1"]);
  }),
);

const voiceRelease = (version: string) => {
  const base = `https://github.com/${FORK_RELEASE.repository}/releases`;
  const archive = `t3-${version}-linux-x64.tar.gz`;
  return {
    tag_name: `v${version}`,
    html_url: `${base}/tag/v${version}`,
    prerelease: true,
    assets: [archive, "SHA256SUMS"].map((name) => ({
      name,
      browser_download_url: `${base}/download/v${version}/${name}`,
      content_type: "application/octet-stream",
    })),
  };
};

it.effect("discovers cached fork archives on Voice without consulting npm", () =>
  Effect.gen(function* () {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const urls: string[] = [];
    const service = yield* makeService(
      (input) => {
        calls.push(input);
        return Effect.die("unexpected npm lookup");
      },
      HttpClient.make((request) => {
        urls.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify([
                voiceRelease("0.1.10-voice.5"),
                voiceRelease("0.1.10-voice.6"),
                { ...voiceRelease("9.0.0-voice.1"), draft: true },
                { ...voiceRelease("9.1.0-voice.1"), assets: [] },
                {
                  ...voiceRelease("9.2.0-voice.1"),
                  html_url: "https://github.com/pingdotgg/t3code/releases/tag/v9.2.0-voice.1",
                },
              ]),
            ),
          ),
        );
      }),
      true,
      "0.1.10-voice.5",
    );
    expect(yield* service.get({ spec: "voice" })).toEqual({ version: "0.1.10-voice.6" });
    expect(yield* service.get({ spec: "voice" })).toEqual({ version: "0.1.10-voice.6" });
    expect(urls).toEqual([
      `https://api.github.com/repos/${FORK_RELEASE.repository}/releases?per_page=100&page=1`,
    ]);
    expect(calls).toEqual([]);
  }),
);

it.each([
  "http://localhost:1234/releases",
  "http://127.0.0.1/releases",
  "http://127.0.0.1:0/releases",
  "http://127.0.0.1:65536/releases",
  "http://127.0.0.1.evil.test:1234/releases",
  "http://2130706433:1234/releases",
  "http://user:pass@127.0.0.1:1234/releases",
  "http://127.0.0.1:1234/releases?token=x",
  "http://127.0.0.1:1234/releases#fragment",
  "https://127.0.0.1:1234/releases",
  "https://example.com:1234/releases",
  "http://192.168.1.1:1234/releases",
  "http://127.0.0.1:1234/\\example.com",
  "http://127.0.0.1:1234/\n",
  " http://127.0.0.1:1234/releases",
])("rejects a non-loopback or ambiguous release fixture URL: %s", (url) => {
  expect(NpmRelease.voiceReleaseTestIndexUrl(url)).toBeUndefined();
});

it.each(["http://127.0.0.1:1234/releases", "http://[::1]:65535/releases"])(
  "accepts an explicit loopback release fixture URL: %s",
  (url) => {
    expect(NpmRelease.voiceReleaseTestIndexUrl(url)).toBe(url);
  },
);

it.effect("pages past unavailable Voice archives and bounds a stalled body", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService(
      () => Effect.die("unexpected npm"),
      HttpClient.make((request) => {
        urls.push(request.url);
        const body = request.url.endsWith("page=1")
          ? JSON.stringify(Array.from({ length: 100 }, () => voiceRelease("0.1.10-voice.5")))
          : JSON.stringify([voiceRelease("0.1.10-voice.6")]);
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
      }),
      true,
      "0.1.10-voice.5",
    );
    expect(yield* service.get({ spec: "voice" })).toEqual({ version: "0.1.10-voice.6" });
    expect(urls).toHaveLength(2);
    const stalled = yield* makeService(
      () => Effect.die("unexpected npm"),
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(new ReadableStream()))),
      ),
      true,
      "0.1.10-voice.5",
    );
    const checking = yield* stalled.get({ spec: "voice" }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    expect(Result.isFailure(yield* Fiber.join(checking))).toBe(true);
  }),
);

it.effect.each(["latest", "nightly", "1.0.0", "0.1.10-voice.6"])(
  "Voice rejects upstream or exact registry lookup %s before network",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* makeService(
        () => Effect.die("unexpected npm"),
        noPublicRegistry,
        true,
        "0.1.10-voice.5",
      );
      expect(yield* service.get({ spec }).pipe(Effect.flip)).toBeInstanceOf(ServerNpmReleaseError);
    }),
);

it.effect.each([
  [voiceRelease("0.1.10-voice.4")],
  [voiceRelease("0.1.10-voice.5")],
  [
    {
      ...voiceRelease("0.1.10-voice.6"),
      assets: voiceRelease("0.1.10-voice.6").assets.slice(0, 1),
    },
  ],
  [{ ...voiceRelease("0.1.10-voice.6"), tag_name: "v0.1.10-voice.06" }],
])("offers no unavailable, current or older Voice archive: %j", (releases) =>
  Effect.gen(function* () {
    const service = yield* makeService(
      () => Effect.die("unexpected npm"),
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(releases)))),
      ),
      true,
      "0.1.10-voice.5",
    );
    expect(yield* service.get({ spec: "voice" })).toBeNull();
  }),
);

it.effect("treats a registry 404 as unpublished without trying another registry", () =>
  Effect.gen(function* () {
    const service = yield* makeService(() =>
      Effect.succeed(output('{"error":{"code":"E404"}}', 1)),
    );
    expect(yield* service.get({ spec: version })).toBeNull();
  }),
);

const spawnFailure = () =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: "npm",
      argumentCount: 6,
      cause: new Error("EACCES"),
    }),
  );

it.effect.each([
  output("not json"),
  output('{"error":{"code":"E401","detail":"sensitive"}}', 1),
  output('{"version":"9.9.9"}'),
  output("[]"),
  output("", 9009),
  { ...output(JSON.stringify({ version })), stdoutTruncated: true },
  { ...output(JSON.stringify({ version })), timedOut: true },
  "spawn failure",
] as const)("reports an unavailable lookup rather than an unpublished release: %j", (result) =>
  Effect.gen(function* () {
    const service = yield* makeService(() =>
      result === "spawn failure" ? spawnFailure() : Effect.succeed(result),
    );
    const found = yield* service.get({ spec: version }).pipe(Effect.result);
    expect(Result.isFailure(found)).toBe(true);
    if (Result.isFailure(found)) {
      expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
      expect(found.failure.message).not.toContain("sensitive");
    }
  }),
);

it.effect("falls back to public npm only when npm is not installed", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService(
      () => Effect.die("npm is not installed"),
      HttpClient.make((request) => {
        urls.push(request.url);
        const response = request.url.endsWith("/nightly")
          ? new Response(JSON.stringify({ version, t3code: { databaseMigration: 42 } }))
          : request.url.endsWith("/latest")
            ? new Response(new ReadableStream())
            : new Response("{}", { status: 404 });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
      false,
    );
    expect(yield* service.get({ spec: "nightly" })).toEqual({ version, databaseMigration: 42 });
    expect(yield* service.get({ spec: "9.9.9" })).toBeNull();
    const stalled = yield* service.get({ spec: "latest" }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    expect(Result.isFailure(yield* Fiber.join(stalled))).toBe(true);
    expect(urls).toEqual([
      "https://registry.npmjs.org/t3/nightly",
      "https://registry.npmjs.org/t3/9.9.9",
      "https://registry.npmjs.org/t3/latest",
    ]);
  }),
);

it.effect("runs at most two npm lookups at once", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<void>();
    let running = 0;
    let peak = 0;
    const service = yield* makeService(() =>
      Effect.gen(function* () {
        peak = Math.max(peak, ++running);
        yield* Queue.offer(started, undefined);
        yield* Deferred.await(release);
        running--;
        return output('{"error":{"code":"E404"}}', 1);
      }),
    );
    const lookups = yield* Effect.forEach(
      ["1.0.0", "1.0.1", "1.0.2"],
      (spec) => service.get({ spec }),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Queue.take(started);
    yield* Queue.take(started);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(lookups)).toEqual([null, null, null]);
    expect(peak).toBe(2);
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs before spawning npm: %s",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* makeService(() => Effect.die("invalid specs must not spawn npm"));
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
    }),
);
