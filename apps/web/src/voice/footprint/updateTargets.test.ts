import { EnvironmentId, type ServerInstallation } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  collectServerUpdateTargets,
  type UpdateEverythingMachine,
} from "../../components/sidebar/updateEverything.logic";
import { manualServerUpdateCommand, resolveVersionMismatch } from "../../versionSkew";

// Stable clients must still direct Voice targets to fork releases.
vi.mock("../../branding", () => ({ APP_VERSION: "0.0.34" }));

function machine(
  id: string,
  version = "0.1.10-voice.5",
  canMaintain = true,
): UpdateEverythingMachine {
  const environmentId = EnvironmentId.make(id);
  return {
    environmentId,
    label: id,
    connected: true,
    hostedByThisApp: false,
    canMaintain,
    updateState: { status: "idle" },
    serverConfig: {
      environment: {
        environmentId,
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion: version,
        capabilities: {
          repositoryIdentity: true,
          serverSelfUpdate: "boot-service",
          voiceReleaseLookup: true,
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
  };
}

it("targets each discovered Voice release, preserving permission, policy and channel guards", () => {
  const behind = machine("behind");
  const current = machine("current", "0.1.10-voice.6");
  const ahead = machine("ahead", "0.1.10-voice.7");
  const denied = machine("denied", "0.1.10-voice.5", false);
  const stable = machine("stable", "0.1.10");
  const stableBehind = machine("stable-behind", "0.1.9");
  const unpublished = machine("unpublished");
  const nightlyBlocked = machine("nightly-blocked");
  const allBlocked = machine("all-blocked");
  const machines = [
    behind,
    current,
    ahead,
    denied,
    stable,
    stableBehind,
    unpublished,
    {
      ...nightlyBlocked,
      serverConfig: {
        ...nightlyBlocked.serverConfig!,
        managedPolicy: {
          organization: "Example",
          lockedSettings: [],
          limits: { updates: { mode: "auto", allowNightly: false } },
        },
      },
    },
    {
      ...allBlocked,
      serverConfig: {
        ...allBlocked.serverConfig!,
        managedPolicy: {
          organization: "Example",
          lockedSettings: [],
          limits: { updates: { mode: "off" } },
        },
      },
    },
  ] satisfies UpdateEverythingMachine[];
  const releases = new Map(
    machines
      .filter((host) => host !== unpublished)
      .map((host) => [host.environmentId, "0.1.10-voice.6"]),
  );
  releases.set(nightlyBlocked.environmentId, "0.1.10-voice.8");
  const result = collectServerUpdateTargets(machines, "0.1.10-voice.5", releases);
  expect(
    result.targets.map(({ environmentId, targetVersion, selfUpdate }) => ({
      environmentId,
      targetVersion,
      selfUpdate,
    })),
  ).toEqual([
    {
      environmentId: behind.environmentId,
      targetVersion: "0.1.10-voice.6",
      selfUpdate: "boot-service",
    },
    {
      environmentId: nightlyBlocked.environmentId,
      targetVersion: "0.1.10-voice.8",
      selfUpdate: "boot-service",
    },
  ]);
  expect(result.skipped).toEqual([
    { environmentId: denied.environmentId, label: "denied", reason: "no permission" },
    {
      environmentId: stableBehind.environmentId,
      label: "stable-behind",
      reason: "on the stable channel",
    },
    {
      environmentId: allBlocked.environmentId,
      label: "all-blocked",
      reason: "Example manages T3 Code updates.",
    },
  ]);
});

it("omits capable Voice hosts with no discovered release instead of falling back to the client", () => {
  const capable = machine("lookup-pending");
  expect(collectServerUpdateTargets([capable], "0.1.10-voice.9")).toEqual({
    targets: [],
    skipped: [],
  });
  // Older hosts retain the existing client-version behavior; this test does not invent a new capability.
  const legacy = machine("legacy");
  const legacyConfig = legacy.serverConfig!;
  const result = collectServerUpdateTargets(
    [
      {
        ...legacy,
        serverConfig: {
          ...legacyConfig,
          environment: {
            ...legacyConfig.environment,
            capabilities: { repositoryIdentity: true, serverSelfUpdate: "boot-service" },
          },
        },
      },
    ],
    "0.1.10-voice.6",
  );
  expect(result.targets).toMatchObject([
    { environmentId: legacy.environmentId, targetVersion: "0.1.10-voice.6" },
  ]);
  expect(result.skipped).toEqual([]);
});

it.each([
  ["0.1.10-voice.5", "0.1.10-voice.6", true],
  ["0.1.10-voice.6", "0.1.10-voice.5", false],
  ["0.1.10-voice.6", "0.1.10-voice.6", false],
  ["0.1.10-voice.9", "0.1.10-voice.10", true],
  ["0.1.10-voice.10", "0.1.10-voice.9", false],
  ["0.1.10", "0.1.10-voice.6", false],
  ["0.1.10-voice.5", "0.1.10", false],
  ["0.1.9-voice.9", "0.1.10-voice.1", true],
])("compares server %s against client %s without offering downgrades", (server, client, behind) => {
  const mismatch = resolveVersionMismatch(server, client);
  if (behind) expect(mismatch).toMatchObject({ serverVersion: server, clientVersion: client });
  else expect(mismatch).toBeNull();
});

const installations: (ServerInstallation | undefined)[] = [
  undefined,
  { kind: "npm-global", prefix: "/opt/example-node" },
  { kind: "pnpm-dlx" },
  { kind: "bunx" },
  { kind: "npx" },
];
it.each(installations)("gives manual fork release guidance for Voice on %j", (installation) => {
  const guidance = manualServerUpdateCommand("0.1.10-voice.6", installation);
  expect(guidance).toContain("0.1.10-voice.6");
  expect(guidance).toContain("https://github.com/NotRllyRn/t3code-voice/releases");
  expect(guidance).toContain("manual");
  expect(guidance).not.toMatch(/pingdotgg|npm install|pnpm dlx|bunx|npx|install\.sh|t3 update/);
});

it("uses the proven launcher with shell-quoted paths for a Voice update", () => {
  expect(
    manualServerUpdateCommand("0.1.10-voice.6", {
      kind: "t3-launcher",
      launcher: "/opt/example's bin/t3",
      baseDir: "/data/example home",
    }),
  ).toBe("'/opt/example'\\''s bin/t3' update --base-dir '/data/example home' 0.1.10-voice.6");
});
