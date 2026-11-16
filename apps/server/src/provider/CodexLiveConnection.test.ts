import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { makeCodexLiveConnection } from "./CodexLiveConnection.ts";

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
    const absent = yield* (yield* make(fixture({ env_key: "SELECTED_KEY" }), {
      OPENAI_API_KEY: "wrong-global-key",
    }))
      .resolveLiveConnection()
      .pipe(Effect.result);
    expect(absent._tag).toBe("Failure");
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
      const resolver = yield* make(fixture(override), {
        SELECTED_KEY: "",
        OPENAI_API_KEY: "wrong-global-key",
      });
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
      {
        ...bad,
        origins: {
          ...bad.origins,
          model_provider: {
            name: { type: "user", file: "/other/config.toml", profile: "unsafe" },
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
