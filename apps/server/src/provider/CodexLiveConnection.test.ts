import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { makeCodexLiveConnection } from "./CodexLiveConnection.ts";
import sessionConfig from "./testFixtures/codex-0.166.0-live-config.json" with { type: "json" };
import normalizedConfig from "./testFixtures/codex-0.169.0-live-config.json" with { type: "json" };

const fixture = (overrides: Record<string, unknown> = {}) => ({
  config: {
    model_provider: "fixture",
    model_providers: {
      fixture: {
        base_url: "https://relay.example.test/prefix/v1",
        wire_api: "responses",
        requires_openai_auth: false,
        experimental_bearer_token: "fictional-private-bearer",
        ...overrides,
      },
    },
  },
  origins: {
    model_provider: {
      name: { type: "user", file: "/fixture/shadow/config.toml" },
      version: "private-config-version",
    },
    model_providers: {
      name: { type: "user", file: "/fixture/shadow/config.toml" },
      version: "private-config-version",
    },
  },
});
const make = (config: unknown, environment: NodeJS.ProcessEnv = {}) =>
  makeCodexLiveConnection({
    homePath: "/fixture/shadow",
    launchArgs: "",
    environment,
    readConfig: Effect.succeed(Redacted.make(config)),
  });

const ownedDestination = {
  name: "Fictional relay",
  base_url: "https://relay.example.test/prefix/v1",
  wire_api: "responses",
  requires_openai_auth: false,
  supports_websockets: true,
};
const ownerArgs = Object.entries({
  model_provider: "fixture",
  ...Object.fromEntries(
    Object.entries(ownedDestination).map(([key, value]) => [
      `model_providers.fixture.${key}`,
      value,
    ]),
  ),
})
  .map(([key, value]) => `-c '${key}=${JSON.stringify(value)}'`)
  .join(" ");
const ownerConfig = () => ({
  ...sessionConfig,
  config: {
    ...sessionConfig.config,
    model_providers: {
      fixture: { ...sessionConfig.config.model_providers.fixture, ...ownedDestination },
    },
  },
  origins: {
    ...sessionConfig.origins,
    ...Object.fromEntries(
      [
        "model_provider",
        ...Object.keys(ownedDestination).map((key) => `model_providers.fixture.${key}`),
      ].map((key) => [key, sessionConfig.origins.thread_unload_delay_secs]),
    ),
  },
  layers: [
    {
      ...sessionConfig.layers[0],
      config: {
        thread_unload_delay_secs: 0,
        model_provider: "fixture",
        model_providers: { fixture: ownedDestination },
      },
    },
    ...sessionConfig.layers.slice(1),
  ],
});

it.effect("binds owner destination args to effective config and selected-home credentials", () =>
  Effect.gen(function* () {
    for (const credential of [
      { env_key: "SELECTED_KEY", experimental_bearer_token: null },
      { env_key: null, experimental_bearer_token: "fictional-owner-key" },
    ]) {
      const config = ownerConfig();
      Object.assign(config.config.model_providers.fixture, credential);
      Object.assign(config.origins, {
        "model_providers.fixture.experimental_bearer_token":
          sessionConfig.origins["model_providers.fixture.env_key"],
      });
      const resolver = yield* makeCodexLiveConnection({
        homePath: "/fixture/shadow",
        launchArgs:
          credential.env_key == null
            ? ownerArgs
            : ownerArgs.replace('"Fictional relay"', "Fictional relay"),
        environment: { SELECTED_KEY: "fictional-owner-key", OPENAI_API_KEY: "wrong-global-key" },
        readConfig: Effect.succeed(Redacted.make(config)),
      });
      const connection = yield* resolver.resolveLiveConnection();
      expect(connection.createUrl).toBe("https://relay.example.test/prefix/v1/live");
      expect(Redacted.value(connection.headers).Authorization).toBe("Bearer fictional-owner-key");
      expect(JSON.stringify(connection)).not.toContain("fictional-owner-key");
    }
    const missing = yield* (yield* makeCodexLiveConnection({
      homePath: "/fixture/shadow",
      launchArgs: ownerArgs,
      environment: { OPENAI_API_KEY: "wrong-global-key" },
      readConfig: Effect.succeed(Redacted.make(ownerConfig())),
    }))
      .resolveLiveConnection()
      .pipe(Effect.result);
    expect(missing._tag).toBe("Failure");
    if (missing._tag === "Failure") expect(missing.failure.reason).toBe("auth-required");
  }),
);

it.effect(
  "rejects unmatched owner args and project or arbitrary session overrides without leaks",
  () =>
    Effect.gen(function* () {
      const original = ownerConfig();
      const sessionOrigin = sessionConfig.origins.thread_unload_delay_secs;
      for (const config of [
        sessionConfig,
        {
          ...original,
          origins: Object.fromEntries(
            Object.entries(original.origins).filter(
              ([path]) => path !== "model_providers.fixture.env_key",
            ),
          ),
        },
        { ...original, layers: undefined },
        { ...original, layers: [...original.layers, original.layers[0]] },
        { ...original, layers: [...original.layers, { name: { type: "project" } }] },
        ...[
          "model_provider",
          "model_providers.fixture.base_url",
          "model_providers.fixture.env_key",
        ].map((key) => ({
          ...original,
          origins: { ...original.origins, [key]: { name: { type: "project" }, version: "poison" } },
        })),
        ...["model_providers.fixture.env_key", "model_providers", "env.SELECTED_KEY"].map(
          (key) => ({
            ...original,
            origins: { ...original.origins, [key]: sessionOrigin },
          }),
        ),
        {
          ...original,
          origins: { ...original.origins, model_provider: { ...sessionOrigin, version: "poison" } },
        },
        {
          ...original,
          config: {
            ...original.config,
            model_providers: {
              fixture: {
                ...original.config.model_providers.fixture,
                base_url: "https://poison.example.test/v1",
              },
            },
          },
        },
        {
          ...original,
          layers: [
            {
              ...original.layers[0],
              config: { ...original.layers[0]!.config, env: { SELECTED_KEY: "poison" } },
            },
          ],
        },
      ]) {
        const result = yield* (yield* makeCodexLiveConnection({
          homePath: "/fixture/shadow",
          launchArgs: ownerArgs,
          environment: { SELECTED_KEY: "fictional-owner-key" },
          readConfig: Effect.succeed(Redacted.make(config)),
        }))
          .resolveLiveConnection()
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(JSON.stringify(result)).not.toContain("poison");
        expect(JSON.stringify(result)).not.toContain("fictional-owner-key");
      }
      for (const launchArgs of [
        "",
        `${ownerArgs} --profile poison`,
        `${ownerArgs} -c env.SELECTED_KEY=poison`,
        ownerArgs.replace("fixture", "other"),
        ownerArgs.replace("supports_websockets=true", "requires_openai_auth=false"),
        ownerArgs.replace("supports_websockets=true", "supports_websockets=false"),
      ]) {
        const result = yield* (yield* makeCodexLiveConnection({
          homePath: "/fixture/shadow",
          launchArgs,
          environment: { SELECTED_KEY: "fictional-owner-key" },
          readConfig: Effect.succeed(Redacted.make(original)),
        }))
          .resolveLiveConnection()
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }),
);

// Captured with installed Codex 0.169.0 config/read, a private home and a fictional key.
it.effect(
  "accepts the normalized Codex provider while keeping null and absent fields equivalent",
  () =>
    Effect.gen(function* () {
      // Sanitized native 0.166.0 config/read with normal app-server args; unrelated defaults omitted.
      const session = yield* (yield* make(sessionConfig, {
        SELECTED_KEY: "fictional-instance",
      })).resolveLiveConnection();
      expect(session.createUrl).toBe("https://relay.example.test/prefix/v1/live");
      expect(Redacted.value(session.headers).Authorization).toBe("Bearer fictional-instance");
      const actual = normalizedConfig.config.model_providers.fixture;
      for (const provider of [
        actual,
        Object.fromEntries(Object.entries(actual).filter(([, value]) => value !== null)),
        {
          ...actual,
          name: null,
          supports_websockets: null,
          supports_standalone_web_search: null,
          request_max_retries: 2,
          stream_max_retries: 3,
          stream_idle_timeout_ms: 1000,
          websocket_connect_timeout_ms: 1000,
        },
      ]) {
        const config = {
          ...normalizedConfig,
          config: { ...normalizedConfig.config, model_providers: { fixture: provider } },
        };
        const connection = yield* (yield* make(config)).resolveLiveConnection();
        expect(connection.createUrl).toBe("https://relay.example.test/prefix/v1/live");
        expect(Redacted.value(connection.headers).Authorization).toBe(
          "Bearer fictional-private-bearer",
        );
        expect(JSON.stringify(connection)).not.toContain("fictional-private-bearer");
      }
    }),
);

it.effect("only accepts the app-owned session override with matching effective provenance", () =>
  Effect.gen(function* () {
    const session = sessionConfig.layers[0]!;
    const origin = sessionConfig.origins.thread_unload_delay_secs;
    const configs = [
      undefined,
      null,
      {},
      [],
      { thread_unload_delay_secs: 1 },
      { thread_unload_delay_secs: -0 },
      { thread_unload_delay_secs: "0" },
      ...[
        { model_provider: "poison" },
        ...["base_url", "auth", "credential_file", "env_key", "experimental_bearer_token"].map(
          (key) => ({ model_providers: { fixture: { [key]: "poison" } } }),
        ),
        { shell_environment_policy: { set: { SELECTED_KEY: "poison" } } },
        { env: { SELECTED_KEY: "poison" } },
      ].map((override) => ({ thread_unload_delay_secs: 0, ...override })),
    ];
    for (const config of [
      ...configs.map((config) => ({
        ...sessionConfig,
        layers: [{ ...session, config }, ...sessionConfig.layers.slice(1)],
      })),
      ...[undefined, ""].map((version) => ({
        ...sessionConfig,
        layers: [{ ...session, version }, ...sessionConfig.layers.slice(1)],
      })),
      { ...sessionConfig, layers: [session, session] },
      {
        ...sessionConfig,
        origins: { ...sessionConfig.origins, thread_unload_delay_secs: undefined },
      },
      {
        ...sessionConfig,
        origins: {
          ...sessionConfig.origins,
          thread_unload_delay_secs: { ...origin, version: "other" },
        },
      },
      ...[1, -0, undefined].map((thread_unload_delay_secs) => ({
        ...sessionConfig,
        config: { ...sessionConfig.config, thread_unload_delay_secs },
      })),
      { ...sessionConfig, layers: undefined },
      { ...sessionConfig, layers: sessionConfig.layers.slice(1) },
      ...[
        "model_provider",
        "model_providers",
        "model_providers.fixture",
        "model_providers.fixture.base_url",
        "model_providers.fixture.auth",
        "model_providers.fixture.credential_file",
        "model_providers.fixture.env_key",
        "shell_environment_policy",
        "env.SELECTED_KEY",
      ].map((path) => ({
        ...sessionConfig,
        origins: { ...sessionConfig.origins, [path]: origin },
      })),
      { ...sessionConfig, layers: [...sessionConfig.layers, { name: { type: "project" } }] },
    ]) {
      const result = yield* (yield* make(config, { SELECTED_KEY: "fictional-instance" }))
        .resolveLiveConnection()
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe("unsupported-provider");
    }
    for (const launchArgs of [
      "-c thread_unload_delay_secs=0",
      "-c model_provider=poison",
      "--profile unsafe",
    ]) {
      const resolver = yield* makeCodexLiveConnection({
        homePath: "/fixture/shadow",
        launchArgs,
        environment: { SELECTED_KEY: "fictional-instance" },
        readConfig: Effect.succeed(Redacted.make(sessionConfig)),
      });
      expect((yield* resolver.resolveLiveConnection().pipe(Effect.result))._tag).toBe("Failure");
    }
  }),
);

it.effect("binds each selected home/environment and never borrows a global key", () =>
  Effect.gen(function* () {
    const one = yield* make(fixture({ env_key: "SELECTED_KEY" }), {
      SELECTED_KEY: "fictional-instance-one",
      OPENAI_API_KEY: "wrong-global-key",
    });
    const two = yield* make(fixture(), { OPENAI_API_KEY: "wrong-global-key" });
    const a = yield* one.resolveLiveConnection();
    const b = yield* two.resolveLiveConnection();
    expect(a.createUrl).toBe("https://relay.example.test/prefix/v1/live");
    expect(Redacted.value(a.headers).Authorization).toBe("Bearer fictional-instance-one");
    expect(Redacted.value(b.headers).Authorization).toBe("Bearer fictional-private-bearer");
    expect(a.revision).not.toBe(b.revision);
    expect(JSON.stringify(a)).not.toContain("fictional-instance-one");
    for (const env_key of ["SELECTED_KEY", "", "invalid-key"]) {
      for (const environment of [{ OPENAI_API_KEY: "wrong-global-key" }, { SELECTED_KEY: "" }]) {
        const absent = yield* (yield* make(fixture({ env_key }), environment))
          .resolveLiveConnection()
          .pipe(Effect.result);
        expect(absent._tag).toBe("Failure");
        if (absent._tag === "Failure") expect(absent.failure.reason).toBe("auth-required");
      }
    }
    for (const experimental_bearer_token of [null, undefined, ""]) {
      const absent = yield* (yield* make(fixture({ env_key: null, experimental_bearer_token }), {
        OPENAI_API_KEY: "wrong-global-key",
      }))
        .resolveLiveConnection()
        .pipe(Effect.result);
      expect(absent._tag).toBe("Failure");
      if (absent._tag === "Failure") expect(absent.failure.reason).toBe("auth-required");
    }
  }),
);

it.effect("rejects empty selected credentials, OAuth, commands, headers and unsafe endpoints", () =>
  Effect.gen(function* () {
    for (const override of [
      { env_key: "SELECTED_KEY" },
      { experimental_bearer_token: "" },
      { requires_openai_auth: true },
      { auth: { command: "unsafe" } },
      { http_headers: { Authorization: "poison" } },
      { env_http_headers: { X: "SECRET" } },
      ...[
        "gateway_oauth",
        "aws",
        "project_id",
        "location",
        "credential_file",
        "model_catalog_url",
        "capabilities",
        "query_params",
        "unknown_future_auth",
      ].flatMap((key) => [{ [key]: "poison" }, { [key]: {} }, { [key]: "" }]),
      { unknown_future_auth: null },
      { requires_openai_auth: null },
      { wire_api: null },
      { base_url: null },
      { request_max_retries: "poison" },
      { supports_standalone_web_search: "poison" },
      { experimental_bearer_token: "poison\r\nheader" },
      ...[
        "http://relay.example.test/v1",
        "https://user:pass@relay.example.test/v1",
        "https://relay.example.test/v1?x=1",
        "https://relay.example.test/responses",
        "https://api.openai.com/v1",
        "https://relay.example.test/x/../v1",
      ].map((base_url) => ({ base_url })),
    ]) {
      const resolver = yield* make(
        {
          ...normalizedConfig,
          config: {
            ...normalizedConfig.config,
            model_providers: {
              fixture: { ...normalizedConfig.config.model_providers.fixture, ...override },
            },
          },
        },
        {
          SELECTED_KEY: "",
          OPENAI_API_KEY: "wrong-global-key",
        },
      );
      const result = yield* resolver.resolveLiveConnection().pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(JSON.stringify(result)).not.toContain("poison");
      expect(JSON.stringify(result)).not.toContain("wrong-global-key");
    }
  }),
);

it.effect("rejects project/profile/CLI ownership and revalidates private revisions", () =>
  Effect.gen(function* () {
    const bad = fixture();
    const project = {
      ...bad,
      origins: {
        ...bad.origins,
        model_providers: {
          name: { type: "project", dotCodexFolder: "/untrusted/.codex" },
          version: "x",
        },
      },
    };
    for (const config of [
      project,
      { ...bad, origins: {} },
      { ...bad, layers: [{ name: { type: "project" }, disabledReason: null }] },
      {
        ...bad,
        origins: {
          ...bad.origins,
          "model_providers.fixture.env_key": {
            name: { type: "user", file: "/fixture/shadow/config.toml", profile: "poison" },
            version: "x",
          },
        },
      },
      {
        ...bad,
        origins: {
          ...bad.origins,
          "model_providers.fixture.base_url": {
            name: { type: "project", file: "/untrusted/config.toml" },
            version: "x",
          },
        },
      },
      {
        ...bad,
        origins: {
          ...bad.origins,
          model_provider: {
            name: { type: "user", file: "/other/config.toml", profile: null },
            version: "x",
          },
        },
      },
    ]) {
      expect((yield* (yield* make(config)).resolveLiveConnection().pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }
    let current: unknown = fixture();
    const resolver = yield* makeCodexLiveConnection({
      homePath: "/fixture/shadow",
      launchArgs: "",
      environment: {},
      readConfig: Effect.sync(() => Redacted.make(current)),
    });
    const first = yield* resolver.resolveLiveConnection();
    expect((yield* resolver.resolveLiveConnection()).revision).toBe(first.revision);
    const same = fixture();
    current = {
      origins: Object.fromEntries(Object.entries(same.origins).reverse()),
      config: {
        model_providers: {
          fixture: Object.fromEntries(
            Object.entries(same.config.model_providers.fixture).reverse(),
          ),
        },
        model_provider: same.config.model_provider,
      },
    };
    expect((yield* resolver.resolveLiveConnection()).revision).toBe(first.revision);
    current = fixture({ experimental_bearer_token: "fictional-rotated" });
    expect((yield* resolver.resolveLiveConnection()).revision).not.toBe(first.revision);
    const cli = yield* makeCodexLiveConnection({
      homePath: "/fixture/shadow",
      launchArgs: "--profile unsafe",
      environment: {},
      readConfig: Effect.succeed(Redacted.make(bad)),
    });
    expect((yield* cli.resolveLiveConnection().pipe(Effect.result))._tag).toBe("Failure");
  }),
);
