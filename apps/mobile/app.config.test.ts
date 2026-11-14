import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { ExpoConfig } from "expo/config";
import { afterEach, expect, it, vi } from "vite-plus/test";

import easConfig from "./eas.json";

// Never read repository env files or inherit build credentials in config tests.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: vi.fn(() =>
    Object.fromEntries(
      [
        "APP_VARIANT",
        "T3CODE_IOS_PERSONAL_TEAM",
        "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID",
        "T3CODE_IOS_APPLE_TEAM_ID",
        "T3CODE_RELAY_URL",
        "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
        "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
      ]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
  ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined = undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  vi.stubEnv("EXPO_NO_DOTENV", undefined);
  return (await import("./app.config.ts")).default;
}

function expectForkIdentity(config: ExpoConfig, identifier: string) {
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    `$(AppIdentifierPrefix)${identifier}`,
  ]);
  expect(config.ios?.appleTeamId).toBeUndefined();
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.android?.intentFilters).toBeUndefined();
  expect(config.owner).toBeUndefined();
  expect(config.extra?.eas?.projectId).toBeUndefined();
  expect(config.updates).toEqual({ enabled: false });
  expect(config.extra?.relay?.url).toBeUndefined();
  expect(config.extra?.clerk?.publishableKey).toBeUndefined();
  expect(JSON.stringify(config)).not.toMatch(
    /ARK85ZXQ4Z|com\.t3tools\.t3code|d763fcb8-d37c-41ea-a773-b54a0ab4a454|pingdotgg|u\.expo\.dev|app\.t3\.codes|clerk\.t3\.codes/,
  );
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "io.github.notrllyrn.t3codevoice", "t3code-voice"],
  ["development", "io.github.notrllyrn.t3codevoice.dev", "t3code-voice-dev"],
  ["preview", "io.github.notrllyrn.t3codevoice.preview", "t3code-voice-preview"],
  ["production", "io.github.notrllyrn.t3codevoice", "t3code-voice"],
])("uses isolated fork defaults for APP_VARIANT=%j", async (value, identifier, scheme) => {
  const config = await loadConfig(value);
  expectForkIdentity(config, identifier!);
  expect(config.android?.package).toBe(identifier);
  expect(config.scheme).toBe(scheme);
  expect(config.slug).toBe("t3code-voice");
  expect(config.name).toMatch(/^T3 Code Voice/);
});

it("uses the resolved Personal Team bundle for keychain access and extension configuration", async () => {
  vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM", "1");
  vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID", "com.example.voice");
  const config = await loadConfig("development");
  expectForkIdentity(config, "com.example.voice");
  expect(config.plugins).not.toContain("expo-widgets");
  expect(
    config.plugins?.some((plugin) => Array.isArray(plugin) && plugin[0] === "expo-widgets"),
  ).toBe(false);
  expect(config.plugins).toContainEqual([
    "@clerk/expo",
    { theme: "./clerk-theme.json", appleSignIn: false },
  ]);
  expect(config.plugins).toContainEqual([
    "expo-sharing",
    expect.objectContaining({ ios: expect.objectContaining({ enabled: false }) }),
  ]);
});

it.each([undefined, "not-a-bundle", "com.t3tools.t3code", "com.t3tools.t3code.dev"])(
  "rejects missing, invalid or upstream Personal Team bundle %j",
  async (identifier) => {
    vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM", "1");
    vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID", identifier);
    await expect(loadConfig()).rejects.toThrow("must be your own reverse-DNS identifier");
  },
);

it.each(["ARK85ZXQ4Z", "not-a-team"])("rejects unsafe Apple Team ID %j", async (team) => {
  vi.stubEnv("T3CODE_IOS_APPLE_TEAM_ID", team);
  await expect(loadConfig()).rejects.toThrow("must be your own 10-character Apple Team ID");
});

it("preserves explicit signing and cloud configuration without adding domain claims", async () => {
  vi.stubEnv("T3CODE_IOS_APPLE_TEAM_ID", "EXAMPLE123");
  vi.stubEnv("T3CODE_RELAY_URL", "https://relay.example.test");
  vi.stubEnv("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_example");
  vi.stubEnv("EXPO_PUBLIC_CLERK_JWT_TEMPLATE", "example-template");
  const config = await loadConfig();
  expect(config.ios?.appleTeamId).toBe("EXAMPLE123");
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.extra?.relay?.url).toBe("https://relay.example.test");
  expect(config.extra?.clerk).toEqual({
    publishableKey: "pk_test_example",
    jwtTemplate: "example-template",
  });
  expect(config.extra?.eas?.observe?.endpointUrl).toBe(
    "https://relay.example.test/v1/mobile/observe",
  );
});

it("does not load repository env files when Expo dotenv is disabled", async () => {
  vi.resetModules();
  vi.stubEnv("EXPO_NO_DOTENV", "1");
  const { loadRepoEnv } = await import("../../scripts/lib/public-config.ts");
  vi.mocked(loadRepoEnv).mockClear();
  await import("./app.config.ts");
  expect(loadRepoEnv).not.toHaveBeenCalled();
});

it("has no inherited EAS submission or OTA channel configuration", () => {
  expect(easConfig).not.toHaveProperty("submit");
  expect(easConfig.cli.appVersionSource).toBe("local");
  for (const profile of Object.values(easConfig.build)) {
    expect(profile).not.toHaveProperty("channel");
    expect(profile).not.toHaveProperty("environment");
  }
  expect(JSON.stringify(easConfig)).not.toContain("6787819824");
});

type IntrospectedConfig = ExpoConfig & {
  _internal: {
    modResults: {
      ios: {
        infoPlist: Record<string, unknown>;
        entitlements: Record<string, unknown>;
        expoPlist: Record<string, unknown>;
      };
    };
  };
};

it.each([false, true])(
  "generates isolated native manifest with Personal Team=%j",
  (personalTeam) => {
    const projectRoot = NodeURL.fileURLToPath(new URL(".", import.meta.url));
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3voice-config-"));
    try {
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        ["node_modules/expo/bin/cli", "config", "--type", "introspect", "--json"],
        {
          cwd: projectRoot,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          env: {
            HOME: home,
            PATH: process.env.PATH,
            CI: "1",
            NODE_ENV: "test",
            EXPO_OFFLINE: "1",
            EXPO_NO_TELEMETRY: "1",
            EXPO_NO_DOTENV: "1",
            ...(personalTeam
              ? {
                  APP_VARIANT: "development",
                  T3CODE_IOS_PERSONAL_TEAM: "1",
                  T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.voice",
                }
              : {}),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const config: IntrospectedConfig = JSON.parse(result.stdout);
      const identifier = personalTeam ? "com.example.voice" : "io.github.notrllyrn.t3codevoice";
      expectForkIdentity(config, identifier);
      const { entitlements, infoPlist, expoPlist } = config._internal.modResults.ios;
      expect(entitlements["keychain-access-groups"]).toEqual([
        `$(AppIdentifierPrefix)${identifier}`,
      ]);
      expect(entitlements).not.toHaveProperty("com.apple.developer.associated-domains");
      expect(expoPlist.EXUpdatesEnabled).toBe(false);
      expect(expoPlist).not.toHaveProperty("EXUpdatesURL");
      expect(infoPlist.CFBundleURLTypes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            CFBundleURLSchemes: expect.arrayContaining([
              personalTeam ? "t3code-voice-dev" : "t3code-voice",
            ]),
          }),
        ]),
      );
      expect(infoPlist.NSMicrophoneUsageDescription).toBeTruthy();
      if (personalTeam) {
        for (const capability of [
          "aps-environment",
          "com.apple.developer.applesignin",
          "com.apple.security.application-groups",
        ]) {
          expect(entitlements).not.toHaveProperty(capability);
        }
        expect(config.extra?.eas).not.toHaveProperty("build");
      }
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  },
);
