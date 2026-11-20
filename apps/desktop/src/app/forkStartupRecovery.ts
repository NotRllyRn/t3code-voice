import type { DesktopUpdateState } from "@t3tools/contracts";
import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";

import type { StartupRecoveryOffer } from "./DesktopStartupRecovery.ts";

/** Disabled fork updates must not offer a retained upstream download or reinstall. */
export function forkStartupRecoveryOffer(
  update: DesktopUpdateState,
  managedPolicy = false,
): StartupRecoveryOffer | undefined {
  if (FORK_DESKTOP.manualUpdatesOnly && !update.enabled) {
    return managedPolicy ? { _tag: "ManagedPolicy" } : { _tag: "Releases" };
  }
  return undefined;
}
