import { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { serverEnvironment } from "../../state/server";
import { voiceServerReleasesAtom } from "../voiceServerReleases";

vi.mock("../../state/server", () => ({
  serverEnvironment: { npmRelease: vi.fn(), configValueAtom: vi.fn() },
}));
vi.mock("../../state/presentation", () => ({
  environmentSummaries: {
    connectedEnvironmentIdsAtom: Atom.make(["capable", "older", "stable", "missing"]),
  },
}));

const decodeServerConfig = Schema.decodeSync(ServerConfig);

it("discovers Voice archives per capable Voice host, skipping older, stable and missing hosts", () => {
  const capable = EnvironmentId.make("capable");
  const config = decodeServerConfig({
    environment: {
      environmentId: capable,
      label: "Example",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.1.10-voice.5",
      capabilities: { repositoryIdentity: true, voiceReleaseLookup: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    cwd: "/test",
    keybindingsConfigPath: "/test/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/test/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {},
  });
  vi.mocked(serverEnvironment.configValueAtom)
    .mockReset()
    .mockImplementation((environmentId) =>
      Atom.make(
        environmentId === "missing"
          ? null
          : {
              ...config,
              environment: {
                ...config.environment,
                environmentId: environmentId ?? capable,
                serverVersion: environmentId === "stable" ? "0.1.10" : "0.1.10-voice.5",
                capabilities: {
                  repositoryIdentity: true,
                  ...(environmentId !== "older" ? { voiceReleaseLookup: true } : {}),
                },
              },
            },
      ),
    );
  const query = vi.mocked(serverEnvironment.npmRelease).mockReset();
  query.mockReturnValue(Atom.make(AsyncResult.success({ version: "0.1.10-voice.6" })));
  const registry = AtomRegistry.make();
  try {
    expect([...registry.get(voiceServerReleasesAtom)]).toEqual([[capable, "0.1.10-voice.6"]]);
    expect(query).toHaveBeenCalledExactlyOnceWith({
      environmentId: capable,
      input: { spec: "voice" },
    });
  } finally {
    registry.dispose();
  }
});
