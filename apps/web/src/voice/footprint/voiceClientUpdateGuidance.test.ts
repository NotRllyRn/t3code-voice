import { expect, it, vi } from "vite-plus/test";
import { manualServerUpdateCommand } from "../../versionSkew";

vi.mock("../../branding", () => ({ APP_VERSION: "0.1.10-voice.1" }));

it("uses the client Voice release for manual guidance when the requested core is upstream", () => {
  expect(manualServerUpdateCommand("0.1.11")).toContain("Voice release (0.1.10-voice.1)");
});
