import type { EnvironmentId } from "@t3tools/contracts";
import { parseVoiceVersion } from "@t3tools/shared/voiceRelease";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentSummaries } from "../state/presentation";
import { serverEnvironment } from "../state/server";

export const voiceServerReleasesAtom = Atom.make((get) => {
  const releases = new Map<EnvironmentId, string>();
  for (const environmentId of get(environmentSummaries.connectedEnvironmentIdsAtom)) {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (
      config?.environment.capabilities.voiceReleaseLookup !== true ||
      parseVoiceVersion(config.environment.serverVersion) === null
    )
      continue;
    const release = AsyncResult.getOrElse(
      get(serverEnvironment.npmRelease({ environmentId, input: { spec: "voice" } })),
      () => null,
    );
    if (release !== null) releases.set(environmentId, release.version);
  }
  return releases;
}).pipe(Atom.withLabel("voice-server-releases"));
