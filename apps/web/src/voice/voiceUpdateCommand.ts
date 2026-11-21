import type { ServerInstallation } from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";

import { msg } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";

export function voiceManualServerUpdateCommand(
  targetVersion: string,
  clientVersion: string,
  installation?: ServerInstallation,
  resolve: MessageResolver = m,
): string | null {
  if (
    cliReleaseChannelOf(targetVersion) === "voice" ||
    cliReleaseChannelOf(clientVersion) === "voice"
  ) {
    const voiceVersion =
      cliReleaseChannelOf(targetVersion) === "voice" ? targetVersion : clientVersion;
    if (installation?.kind === "t3-launcher") {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      return `${quote(installation.launcher)} update --base-dir ${quote(installation.baseDir)} ${voiceVersion}`;
    }
    return resolve(
      msg(
        "Install the matching Voice release ({voiceVersion}) from {releasesUrl}. Follow its manual desktop, standalone archive, or Docker server instructions.",
        { voiceVersion, releasesUrl: FORK_DESKTOP.releasesUrl },
      ),
    );
  }
  return null;
}
