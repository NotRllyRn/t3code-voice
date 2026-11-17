import { describe, expect, it } from "@effect/vitest";
import { encodeVoiceMacVersion, isVoiceMacBundleVersion } from "./voiceMacVersion.ts";

describe("Voice native rollback version", () => {
  it("maps canonical bounded Voice releases without collisions across revisions and upstream bases", () => {
    const releases = [
      ["0.0.0-voice.1", "0.0.1"],
      ["0.1.10-voice.1", "0.1.10001"],
      ["0.1.10-voice.2", "0.1.10002"],
      ["0.1.10-voice.999", "0.1.10999"],
      ["0.1.11-voice.1", "0.1.11001"],
      ["0.1.2147483-voice.647", "0.1.2147483647"],
      ["0.2.0-voice.1", "0.2.1"],
      ["0.100.0-voice.1", "0.100.1"],
      ["1.0.0-voice.1", "1.0.1"],
      ["2147483647.2147483647.2147483-voice.647", "2147483647.2147483647.2147483647"],
    ];
    let previous: bigint[] | undefined;
    for (const [semantic, native] of releases) {
      expect(encodeVoiceMacVersion(semantic!)).toBe(native);
      expect(
        isVoiceMacBundleVersion(semantic!, {
          CFBundleShortVersionString: native,
          ElectronSquirrelPreventDowngrades: true,
        }),
      ).toBe(true);
      const parts = native!.split(".").map(BigInt);
      if (previous) {
        const firstDifference = parts.findIndex((part, index) => part !== previous![index]);
        expect(firstDifference).toBeGreaterThanOrEqual(0);
        expect(parts[firstDifference]! > previous[firstDifference]!).toBe(true);
      }
      previous = parts;
    }
  });

  it("rejects overflow, ambiguous and unsupported versions rather than wrapping or truncating", () => {
    for (const version of [
      "0.1.10-voice.0",
      "0.1.10-voice.1000",
      "0.1.10-voice.01",
      "00.1.10-voice.1",
      "0.01.10-voice.1",
      "0.1.010-voice.1",
      "0.1.10",
      "0.1.10-voice.1+dev",
      "0.1.10-nightly.1",
      "0.1.2147483-voice.648",
      "0.1.2147484-voice.1",
      "2147483648.0.0-voice.1",
      "0.2147483648.0-voice.1",
      "0.1.999999999999999999999999999-voice.1",
      "0.1.10-voice.1\n",
    ])
      expect(() => encodeVoiceMacVersion(version)).toThrow();
  });

  it("requires the exact computed native version and a boolean downgrade guard", () => {
    for (const plist of [
      null,
      {},
      { CFBundleShortVersionString: "0.1.10001" },
      { CFBundleShortVersionString: "0.1.10001", ElectronSquirrelPreventDowngrades: false },
      { CFBundleShortVersionString: "0.1.10001", ElectronSquirrelPreventDowngrades: "true" },
      { CFBundleShortVersionString: "0.1.10002", ElectronSquirrelPreventDowngrades: true },
      { CFBundleShortVersionString: "0.1.010001", ElectronSquirrelPreventDowngrades: true },
      { CFBundleShortVersionString: "0.1.10-voice.1", ElectronSquirrelPreventDowngrades: true },
    ])
      expect(isVoiceMacBundleVersion("0.1.10-voice.1", plist)).toBe(false);
    expect(isVoiceMacBundleVersion("0.1.10-voice.1000", {})).toBe(false);
  });
});
