import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";

describe("Voice orchestration protocol compatibility", () => {
  it("rejects upstream protocol collisions and old Voice previews without the history marker", () => {
    for (const protocol of [2, 3]) {
      const error = orchestrationProtocolCompatibilityError({
        environmentId: EnvironmentId.make("environment-remote"),
        label: "Build Mac",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "9.0.0",
        orchestrationProtocolVersion: protocol,
        capabilities: { repositoryIdentity: true, serverSelfUpdate: "boot-service" },
      });
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error?.message).toContain("compatible T3 Code Voice server");
      expect(error).not.toHaveProperty("serverUpdateRequired");
    }
  });
});
