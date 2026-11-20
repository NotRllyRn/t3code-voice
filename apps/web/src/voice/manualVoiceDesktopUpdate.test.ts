import type { DesktopUpdateCheckResult, DesktopUpdateState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { manualVoiceDesktopUpdate } from "./manualVoiceDesktopUpdate";

const state: DesktopUpdateState = {
  enabled: false,
  status: "downloaded",
  channel: "latest",
  currentVersion: "0.1.10-voice.6",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.1.10-voice.7",
  downloadedVersion: "0.1.10-voice.7",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function manual(overrides: Partial<Parameters<typeof manualVoiceDesktopUpdate>[0]> = {}) {
  return manualVoiceDesktopUpdate({
    hasDesktopBridge: true,
    updateState: state,
    isPending: false,
    denial: undefined,
    ...overrides,
  });
}

it("uses the manual path only for a desktop bridge without an enabled updater", () => {
  expect(manual({ hasDesktopBridge: false })).toBeNull();
  expect(manual({ updateState: { ...state, enabled: true } })).toBeNull();
  expect(manual({ updateState: null })).toMatchObject({
    label: "Check Voice updates",
    tooltip: null,
  });
  expect(manual()).toMatchObject({
    label: "Check Voice updates",
    tooltip: null,
    disabled: false,
    description:
      "Check fork releases for an Apple Silicon Mac DMG. Download and install manually; automatic installation is disabled.",
  });
  expect(manual({ isPending: true })?.label).toBe("Checking…");
  expect(manual({ denial: "Managed by Example" })?.disabled).toBe(true);
});

it.each([{ isPending: true }, { denial: "Managed by Example" }])(
  "refuses a check before any side effect for %j",
  async (restriction) => {
    const checkForUpdate = vi.fn();
    const setPending = vi.fn();
    const notify = vi.fn();
    await manual(restriction)!.run({ checkForUpdate }, setPending, notify);
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(setPending).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  },
);

it.each(["resolve", "reject"] as const)(
  "holds pending until the bridge settles (%s), then clears it",
  async (outcome) => {
    let resolve!: (result: DesktopUpdateCheckResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<DesktopUpdateCheckResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const events: unknown[] = [];
    const bridge = {
      checkForUpdate: vi.fn(() => {
        events.push("check");
        return promise;
      }),
    };
    const run = manual()!.run(
      bridge,
      (pending) => events.push(pending),
      (failure) => events.push(failure),
    );
    expect(events).toEqual([true, "check"]);
    if (outcome === "resolve") resolve({ checked: false, state });
    else reject(new Error("Synthetic offline"));
    await run;
    expect(bridge.checkForUpdate).toHaveBeenCalledOnce();
    expect(events).toEqual(
      outcome === "resolve"
        ? [true, "check", false]
        : [
            true,
            "check",
            {
              type: "error",
              title: "Could not check Voice updates",
              description: "Try checking again later.",
            },
            false,
          ],
    );
  },
);
