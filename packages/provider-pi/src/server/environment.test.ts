// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { PiSettings } from "../settings.ts";
import { PiDriver } from "./driver.ts";
import { makePiAdapterV2 } from "./adapter.ts";
import { resolvePiStartup } from "./environment.ts";
import { recordResolvedEnvironmentSecrets } from "@t3tools/provider-core/server/instanceEnvironment";
import { buildPiRpcLaunch } from "./mcpInjection.ts";
import { makePiRpcConnection } from "./rpc.ts";

const decodeSettings = Schema.decodeSync(PiSettings);
const temporaryRoot = process.env.TMPDIR ?? "/tmp";
const fixture = Effect.gen(function* () {
  const dir = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.realpathSync(NodeFS.mkdtempSync(`${temporaryRoot}/pi-clean-`))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
  for (const path of ["home", "home/agent", "home/tmp"])
    NodeFS.mkdirSync(`${dir}/${path}`, { mode: 0o700 });
  NodeFS.writeFileSync(
    `${dir}/startup.cjs`,
    `require('node:fs').appendFileSync(${JSON.stringify(`${dir}/canary`)}, 'startup\\n');`,
  );
  NodeFS.writeFileSync(
    `${dir}/pi`,
    `#!/usr/bin/env node
const fs = require('node:fs');
const report = {env: process.env, args: process.argv.slice(2)};
fs.appendFileSync(${JSON.stringify(`${dir}/launches`)}, JSON.stringify(report) + '\\n');
if (process.argv.includes('--version')) { console.log('pi 1.0.2'); process.exit(0); }
let sessionFile = ${JSON.stringify(`${dir}/`)} + (process.argv.includes('--fork') ? 'fork.jsonl' : 'session.jsonl');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'switch_session') sessionFile = request.sessionPath;
  const data = request.type === 'get_state' ? {sessionFile} : request.type === 'report' ? report : request.type === 'get_available_models'
    ? {models: [{provider:'synthetic',id:'model'}]} : request.type === 'get_commands' ? {commands: []}
    : request.type === 'get_last_assistant_text' ? {text: JSON.stringify({subject:'Synthetic subject',body:''})} : {};
  console.log(JSON.stringify({type:'response',id:request.id,success:true,data}));
  if (request.type === 'prompt') console.log(JSON.stringify({type:'agent_settled'}));
});
`,
    { mode: 0o700 },
  );
  const settings = decodeSettings({
    enabled: true,
    binaryPath: `${dir}/pi`,
    environmentMode: "clean",
    cleanEnvironment: {
      home: `${dir}/home`,
      agentDirectory: `${dir}/home/agent`,
      tempDirectory: `${dir}/home/tmp`,
      pathDirectories: [
        NodeFS.realpathSync(NodePath.dirname(process.execPath)),
        "/usr/bin",
        "/bin",
      ],
    },
  });
  return { dir, settings };
});

const contaminated = (dir: string): NodeJS.ProcessEnv => ({
  HOME: "/inherited-home",
  PI_CODING_AGENT_DIR: "/inherited-agent",
  PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin`,
  NODE_OPTIONS: `--require=${dir}/startup.cjs`,
  LD_PRELOAD: "",
  DYLD_INSERT_LIBRARIES: "synthetic-canary",
  PYTHONPATH: "synthetic-canary",
  BASH_ENV: "synthetic-canary",
  AWS_SECRET_ACCESS_KEY: "synthetic-canary",
  GH_TOKEN: "synthetic-canary",
  SSH_AUTH_SOCK: "synthetic-canary",
  npm_config_userconfig: "synthetic-canary",
  HTTPS_PROXY: "synthetic-canary",
  T3_ACP_MCP_TOKEN: "synthetic-canary",
  T3_ACP_MCP_NODE: "synthetic-canary",
  T3_MCP_BEARER_TOKEN: "stale-native-token",
  T3_PI_RUNTIME_MODE: "full-access",
});

it.effect("retains only registry-resolved credentials, never inherited or forged provenance", () =>
  Effect.gen(function* () {
    const { dir, settings } = yield* fixture;
    const inherited = { ...contaminated(dir), OPENAI_API_KEY: "inherited-token" };
    const provenance = recordResolvedEnvironmentSecrets([
      { name: "OPENAI_API_KEY", value: "scoped-token" },
    ]);
    expect(
      (yield* resolvePiStartup(settings, inherited, provenance)).environment.OPENAI_API_KEY,
    ).toBe("scoped-token");
    expect(
      (yield* resolvePiStartup(settings, inherited)).environment.OPENAI_API_KEY,
    ).toBeUndefined();
    expect(JSON.stringify(provenance)).not.toContain("scoped-token");
    const forged = JSON.parse(JSON.stringify(provenance));
    const settingsWithForgedProvenance = { ...settings, environmentSecrets: forged };
    expect(
      (yield* resolvePiStartup(settingsWithForgedProvenance, inherited)).environment.OPENAI_API_KEY,
    ).toBeUndefined();
    const result = yield* Effect.result(resolvePiStartup(settings, inherited, forged));
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).not.toContain("scoped-token");
    expect(
      (yield* resolvePiStartup({ ...settings, environmentMode: "inherit" }, inherited)).environment,
    ).toBe(inherited);
  }).pipe(Effect.scoped),
);

it.effect.each([
  "PATH",
  "HOME",
  "PI_CODING_AGENT_DIR",
  "PI_TEST",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "T3_MCP_BEARER_TOKEN",
  "T3_ACP_MCP_TOKEN",
  "GH_TOKEN",
  "openai_api_key",
])("rejects resolved secret key %s without exposing its value", (name) =>
  Effect.gen(function* () {
    const { settings } = yield* fixture;
    const result = yield* Effect.result(
      resolvePiStartup(
        settings,
        {},
        recordResolvedEnvironmentSecrets([{ name, value: "denied-secret-canary" }]),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).not.toContain("denied-secret-canary");
  }).pipe(Effect.scoped),
);

it.effect("checks operator models.json before launch without changing exact model metadata", () =>
  Effect.gen(function* () {
    const { dir, settings } = yield* fixture;
    const path = `${dir}/home/agent/models.json`;
    const metadata = {
      providers: {
        gateway: {
          baseUrl: "https://gateway.example.test/v1",
          api: "openai-completions",
          apiKey: "OPENAI_API_KEY",
          headers: {
            "hTtP-ReFeReR": "https://example.test",
            "x-TiTlE": "Coding client",
            Authorization: "$OPENAI_API_KEY",
            "X-Api-Key": "${OPENAI_API_KEY}",
          },
          models: [
            {
              id: "exact/model",
              name: "Exact Model",
              reasoning: true,
              input: ["text"],
              contextWindow: 123456,
              maxTokens: 1234,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    };
    const text = JSON.stringify(metadata);
    NodeFS.writeFileSync(path, text);
    yield* resolvePiStartup(settings, {});
    expect(NodeFS.readFileSync(path, "utf8")).toBe(text);
    for (const override of [
      { apiKey: "!echo command-secret-canary" },
      { apiKey: "raw-secret-canary" },
      { headers: { Authorization: "raw-secret-canary" } },
      { headers: { "X-Api-Key": "raw-secret-canary" } },
      { headers: { "X-Unknown": "public-looking-secret-canary" } },
      { headers: { "HTTP-Referer": "!echo command-secret-canary" } },
      { headers: { "X-Title": "  !echo command-secret-canary" } },
      { headers: { "X-Title": 123 } },
      { headers: { Authorization: "!echo command-secret-canary" } },
      { models: [{ id: "x", headers: { Authorization: "!echo command-secret-canary" } }] },
      { apiKey: "$GH_TOKEN" },
      { modelOverrides: { "exact/model": { headers: { Authorization: "!echo secret-canary" } } } },
    ]) {
      NodeFS.writeFileSync(
        path,
        JSON.stringify({ providers: { gateway: { ...metadata.providers.gateway, ...override } } }),
      );
      const result = yield* Effect.result(resolvePiStartup(settings, {}));
      expect(result._tag).toBe("Failure");
      expect(JSON.stringify(result)).not.toContain("secret-canary");
      expect(NodeFS.existsSync(`${dir}/launches`)).toBe(false);
    }
    NodeFS.writeFileSync(path, '{"apiKey":"malformed-secret-canary');
    const malformed = yield* Effect.result(resolvePiStartup(settings, {}));
    expect(malformed._tag).toBe("Failure");
    expect(JSON.stringify(malformed)).not.toContain("malformed-secret-canary");
  }).pipe(Effect.scoped),
);

it.live.each(["--api-key cli-secret-canary", "--api-key=cli-secret-canary"])(
  "rejects clean driver startup before any spawn for %s",
  (launchArgs) =>
    Effect.gen(function* () {
      const { dir, settings } = yield* fixture;
      const config = { ...settings, launchArgs };
      const layer = Layer.mergeAll(
        TestProviderHost.layer({
          cwd: dir,
          settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
          runBackgroundWork: false,
        }),
        IdAllocator.layer,
        McpProviderSessions.layer,
        ProviderLatestVersions.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected network")),
        ),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      const result = yield* Effect.gen(function* () {
        const instance = yield* PiDriver.create({
          instanceId: ProviderInstanceId.make("pi-clean-cli-test"),
          displayName: undefined,
          enabled: true,
          environment: [],
          config,
        });
        yield* instance.snapshot.refresh;
      }).pipe(
        Effect.result,
        Effect.provide(layer),
        Effect.provideService(HostProcess.Environment, contaminated(dir)),
      );
      expect(NodeFS.existsSync(`${dir}/launches`)).toBe(false);
      expect(NodeFS.existsSync(`${dir}/canary`)).toBe(false);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          detail: "Invalid Pi startup environment.",
          cause: { cause: { message: "Clean Pi does not allow --api-key launch arguments." } },
        },
      });
      expect(JSON.stringify(result)).not.toContain("cli-secret-canary");
      const inherited = contaminated(dir);
      expect(
        (yield* resolvePiStartup({ ...config, environmentMode: "inherit" }, inherited)).environment,
      ).toBe(inherited);
    }).pipe(Effect.scoped),
);

it.live.each(["/usr/bin/env node", process.execPath])(
  "blocks inherited startup code before %s, retaining exact native MCP argv and fresh transport",
  (interpreter) =>
    Effect.gen(function* () {
      const { dir, settings } = yield* fixture;
      NodeFS.writeFileSync(
        settings.binaryPath,
        NodeFS.readFileSync(settings.binaryPath, "utf8").replace(/^#![^\n]*/, `#!${interpreter}`),
      );
      for (const environmentMode of ["inherit", "clean"] as const) {
        const inherited = contaminated(dir);
        const { environment: base, executable } = yield* resolvePiStartup(
          { ...settings, environmentMode },
          inherited,
        );
        if (environmentMode === "inherit") expect(base).toBe(inherited);
        const launch = buildPiRpcLaunch({
          environment: base,
          launchArgs: ["--model", "synthetic/model", "--skill", "a path with spaces"],
          extensionPath: `${dir}/synthetic-extension.ts`,
          runtimeMode: "approval-required",
          mcpSession: {
            environmentId: EnvironmentId.make("synthetic-environment"),
            threadId: ThreadId.make("synthetic-thread"),
            providerSessionId: "synthetic-session",
            providerInstanceId: ProviderInstanceId.make("pi-clean-test"),
            endpoint: "http://127.0.0.1:12345/synthetic-unused",
            authorizationHeader: "Bearer synthetic-fresh-token",
            browserToolsAvailable: false,
          },
        });
        const report = yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* makePiRpcConnection({
              command: executable.command,
              args: [...executable.args, ...launch.args],
              cwd: dir,
              env: launch.env,
            });
            return yield* connection.request({ type: "report" });
          }),
        );
        expect(report).toEqual({
          env: launch.env,
          args: [
            "--mode",
            "rpc",
            "--model",
            "synthetic/model",
            "--skill",
            "a path with spaces",
            "--extension",
            `${dir}/synthetic-extension.ts`,
          ],
        });
        expect(NodeFS.existsSync(`${dir}/canary`)).toBe(environmentMode === "inherit");
        expect(launch.env.T3_MCP_BEARER_TOKEN).toBe("synthetic-fresh-token");
        expect(launch.env.T3_MCP_URL).toBe("http://127.0.0.1:12345/synthetic-unused");
        expect(launch.env.T3_PI_RUNTIME_MODE).toBe("approval-required");
        if (environmentMode === "clean") {
          expect(Object.keys(base).sort()).toEqual(
            [
              "HOME",
              "LANG",
              "LC_ALL",
              "PATH",
              "PI_CODING_AGENT_DIR",
              "TEMP",
              "TMP",
              "TMPDIR",
            ].sort(),
          );
          expect(JSON.stringify(report)).not.toContain("synthetic-canary");
        }
        NodeFS.rmSync(`${dir}/canary`, { force: true });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "pins clean executables across probes, text generation, session startup and forks after alias swaps",
  () =>
    Effect.gen(function* () {
      const { dir, settings } = yield* fixture;
      NodeFS.mkdirSync(`${dir}/aliases`, { mode: 0o777 });
      NodeFS.chmodSync(`${dir}/aliases`, 0o777);
      NodeFS.mkdirSync(`${dir}/nodebin`, { mode: 0o700 });
      NodeFS.symlinkSync(`${dir}/pi`, `${dir}/aliases/pi`);
      NodeFS.symlinkSync(process.execPath, `${dir}/nodebin/node`);
      const aliasedSettings = {
        ...settings,
        binaryPath: `${dir}/aliases/pi`,
        cleanEnvironment: {
          ...settings.cleanEnvironment!,
          pathDirectories: [`${dir}/nodebin`],
        },
      };
      const layer = Layer.mergeAll(
        TestProviderHost.layer({
          cwd: dir,
          settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
          runBackgroundWork: false,
        }),
        IdAllocator.layer,
        McpProviderSessions.layer,
        ProviderLatestVersions.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected network")),
        ),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const inherited = yield* makePiAdapterV2({
            instanceId: ProviderInstanceId.make("pi-clean-test"),
            settings: { ...settings, environmentMode: "inherit" },
            environment: contaminated(dir),
          });
          const refused = yield* inherited
            .openSession({
              threadId: ThreadId.make("synthetic-refused"),
              providerSessionId: ProviderSessionId.make("synthetic-refused"),
              modelSelection: createModelSelection(
                ProviderInstanceId.make("pi-clean-test"),
                "default",
              ),
              runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: dir,
                cleanProviderConstraint: {
                  instanceId: ProviderInstanceId.make("pi-clean-test"),
                  driver: "pi",
                  environmentMode: "clean",
                },
              }),
            })
            .pipe(Effect.result);
          expect(refused._tag).toBe("Failure");
          expect(NodeFS.existsSync(`${dir}/launches`)).toBe(false);
          expect(NodeFS.existsSync(`${dir}/canary`)).toBe(false);
          const instance = yield* PiDriver.create({
            instanceId: ProviderInstanceId.make("pi-clean-test"),
            displayName: undefined,
            enabled: true,
            environment: [
              { name: "GH_TOKEN", value: "synthetic-instance-secret", sensitive: true },
            ],
            environmentSecrets: recordResolvedEnvironmentSecrets([
              { name: "OPENAI_API_KEY", value: "synthetic-scoped-key" },
            ]),
            config: aliasedSettings,
          });
          NodeFS.writeFileSync(
            `${dir}/wrapper`,
            `#!/bin/sh\necho startup >> '${dir}/alias-canary'\nexec '${dir}/pi' "$@"\n`,
            { mode: 0o700 },
          );
          NodeFS.writeFileSync(
            `${dir}/node-wrapper`,
            `#!/bin/sh\necho startup >> '${dir}/alias-canary'\nexec '${process.execPath}' "$@"\n`,
            { mode: 0o700 },
          );
          NodeFS.unlinkSync(`${dir}/aliases/pi`);
          NodeFS.symlinkSync(`${dir}/wrapper`, `${dir}/aliases/pi`);
          NodeFS.unlinkSync(`${dir}/nodebin/node`);
          NodeFS.symlinkSync(`${dir}/node-wrapper`, `${dir}/nodebin/node`);
          yield* instance.snapshot.refresh;
          const snapshot = yield* instance.snapshotForCwd!(dir);
          expect(snapshot.status).toBe("ready");
          expect(snapshot.models.map((model) => model.slug)).toContain("synthetic/model");
          const reply = yield* instance.textGeneration.generateCommitMessage({
            cwd: dir,
            branch: "synthetic",
            stagedSummary: "M synthetic.txt",
            stagedPatch: "synthetic patch",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("pi-clean-test"),
              "default",
            ),
          });
          expect(reply.subject).toBe("Synthetic subject");
          const threadId = ThreadId.make("synthetic-thread");
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            cleanProviderConstraint: {
              instanceId: ProviderInstanceId.make("pi-clean-test"),
              driver: "pi",
              environmentMode: "clean",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: dir,
          });
          const modelSelection = createModelSelection(
            ProviderInstanceId.make("pi-clean-test"),
            "default",
          );
          const runtime = yield* instance.orchestrationAdapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("synthetic-session"),
            modelSelection,
            runtimePolicy,
          });
          const sourceProviderThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const forked = yield* runtime.forkThread({
            sourceProviderThread,
            targetThreadId: ThreadId.make("synthetic-fork"),
          });
          expect(forked.nativeThreadRef?.nativeId).toBe(`${dir}/fork.jsonl`);
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(HostProcess.Environment, contaminated(dir)),
      );
      expect(NodeFS.existsSync(`${dir}/canary`)).toBe(false);
      expect(NodeFS.existsSync(`${dir}/alias-canary`)).toBe(false);
      const reports = NodeFS.readFileSync(`${dir}/launches`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(reports.some((report) => report.args.includes("--version"))).toBe(true);
      expect(reports.filter((report) => report.args.includes("rpc")).length).toBeGreaterThanOrEqual(
        3,
      );
      expect(reports.some((report) => report.args.includes("--no-tools"))).toBe(true);
      expect(reports.some((report) => report.args.includes("--fork"))).toBe(true);
      for (const report of reports) {
        expect(report.env.HOME).toBe(`${dir}/home`);
        expect(report.env.PI_CODING_AGENT_DIR).toBe(`${dir}/home/agent`);
        expect(report.env.NODE_OPTIONS).toBeUndefined();
        expect(report.env.GH_TOKEN).toBeUndefined();
        expect(report.env.OPENAI_API_KEY).toBe("synthetic-scoped-key");
        expect(report.args.join(" ")).not.toContain("synthetic-scoped-key");
        expect(JSON.stringify(report)).not.toContain("synthetic-canary");
      }
    }).pipe(Effect.scoped),
);

it.effect(
  "fails closed for missing configuration, untrusted paths, non-private directories and shell wrappers",
  () =>
    Effect.gen(function* () {
      const { dir, settings } = yield* fixture;
      const config = settings.cleanEnvironment!;
      const { cleanEnvironment: _, ...withoutConfig } = settings;
      for (const candidate of [
        withoutConfig,
        { ...settings, binaryPath: "pi" },
        { ...settings, cleanEnvironment: { ...config, pathDirectories: [] } },
        { ...settings, cleanEnvironment: { ...config, agentDirectory: dir } },
        { ...settings, cleanEnvironment: { ...config, pathDirectories: ["."] } },
      ])
        expect(yield* Effect.result(resolvePiStartup(candidate, contaminated(dir)))).toHaveProperty(
          "_tag",
          "Failure",
        );
      NodeFS.chmodSync(config.home, 0o755);
      expect(yield* Effect.result(resolvePiStartup(settings, {}))).toHaveProperty(
        "_tag",
        "Failure",
      );
      NodeFS.chmodSync(config.home, 0o700);
      NodeFS.mkdirSync(`${dir}/nodebin`, { mode: 0o700 });
      for (const shebang of [`#!${dir}/nodebin/node`, "#!/usr/bin/env node"]) {
        for (const kind of [
          "shell",
          "writable-shell",
          "writable-native",
          "foreign-native",
        ] as const) {
          if (kind === "foreign-native" && process.getuid?.() !== 0) continue;
          NodeFS.rmSync(`${dir}/nodebin/node`, { force: true });
          if (kind === "shell" || kind === "writable-shell") {
            NodeFS.writeFileSync(`${dir}/nodebin/node`, "#!/bin/sh\nexit 0\n");
            NodeFS.chmodSync(`${dir}/nodebin/node`, kind === "shell" ? 0o700 : 0o777);
          } else {
            NodeFS.copyFileSync(
              process.execPath,
              `${dir}/nodebin/node`,
              NodeFS.constants.COPYFILE_FICLONE,
            );
            NodeFS.chmodSync(`${dir}/nodebin/node`, kind === "writable-native" ? 0o777 : 0o700);
            if (kind === "foreign-native") NodeFS.chownSync(`${dir}/nodebin/node`, 65534, 65534);
          }
          NodeFS.writeFileSync(`${dir}/pi`, `${shebang}\nprocess.exit(0);\n`);
          expect(
            yield* Effect.result(
              resolvePiStartup(
                {
                  ...settings,
                  cleanEnvironment: { ...config, pathDirectories: [`${dir}/nodebin`] },
                },
                {},
              ),
            ),
          ).toHaveProperty("_tag", "Failure");
        }
      }
      NodeFS.writeFileSync(`${dir}/wrapper`, '#!/bin/sh\nexec node "$@"\n', { mode: 0o700 });
      expect(
        yield* Effect.result(resolvePiStartup({ ...settings, binaryPath: `${dir}/wrapper` }, {})),
      ).toHaveProperty("_tag", "Failure");
    }).pipe(Effect.scoped),
);
