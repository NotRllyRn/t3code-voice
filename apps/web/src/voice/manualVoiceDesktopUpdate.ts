import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";

import { msg } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";

type UpdateFailure = { type: "error"; title: string; description: string };

export function manualVoiceDesktopUpdate(
  {
    hasDesktopBridge,
    updateState,
    isPending,
    denial,
  }: {
    hasDesktopBridge: boolean;
    updateState: DesktopUpdateState | null;
    isPending: boolean;
    denial: string | undefined;
  },
  resolve: MessageResolver = m,
) {
  if (!hasDesktopBridge || !FORK_DESKTOP.manualUpdatesOnly || updateState?.enabled === true)
    return null;
  return {
    tooltip: null,
    disabled: Boolean(denial),
    label: isPending ? resolve(msg("Checking…")) : resolve(msg("Check Voice updates")),
    description: resolve(
      msg(
        "Check fork releases for an Apple Silicon Mac DMG. Download and install manually; automatic installation is disabled.",
      ),
    ),
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
          title: m(msg("Could not check Voice updates")),
          description: m(msg("Try checking again later.")),
        });
      } finally {
        setPending(false);
      }
    },
  };
}
