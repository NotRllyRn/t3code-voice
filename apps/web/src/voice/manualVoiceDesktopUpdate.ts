import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";

type UpdateFailure = { type: "error"; title: string; description: string };

export function manualVoiceDesktopUpdate({
  hasDesktopBridge,
  updateState,
  isPending,
  denial,
}: {
  hasDesktopBridge: boolean;
  updateState: DesktopUpdateState | null;
  isPending: boolean;
  denial: string | undefined;
}) {
  if (!hasDesktopBridge || !FORK_DESKTOP.manualUpdatesOnly || updateState?.enabled === true)
    return null;
  return {
    tooltip: null,
    disabled: Boolean(denial),
    label: isPending ? "Checking…" : "Check Voice updates",
    description:
      "Check fork releases for an Apple Silicon Mac DMG. Download and install manually; automatic installation is disabled.",
    async run(
      bridge: Pick<DesktopBridge, "checkForUpdate">,
      setPending: (pending: boolean) => void,
      notify: (failure: UpdateFailure) => void,
    ) {
      if (isPending || denial) return;
      setPending(true);
      try {
        await bridge.checkForUpdate();
      } catch {
        notify({
          type: "error",
          title: "Could not check Voice updates",
          description: "Try checking again later.",
        });
      } finally {
        setPending(false);
      }
    },
  };
}
