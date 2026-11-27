import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { encodeVoiceMacVersion } from "../../apps/desktop/src/updates/voiceMacVersion.ts";
import {
  parseVoiceUpdateConfig,
  type VoiceUpdateConfig,
} from "../../apps/desktop/src/updates/voiceUpdateConfig.ts";
import { DesktopBuildCommitError, resolveDesktopBuildCommit } from "./voice-build-commit.ts";
import { resolveVoiceMacUpdate, VoiceMacSigningError } from "./voice-mac-signing.ts";

export {
  DesktopBuildCommitError,
  FORK_DESKTOP,
  resolveDesktopBuildCommit,
  resolveVoiceMacUpdate,
  type VoiceUpdateConfig,
};

export const VOICE_DESKTOP_PROTOCOLS = [
  {
    name: FORK_DESKTOP.productName,
    schemes: [FORK_DESKTOP.scheme, FORK_DESKTOP.developmentScheme],
  },
] as const;

export const resolveVoiceDesktopBuildCommit = Effect.fn("resolveVoiceDesktopBuildCommit")(
  function* (repoRoot: string, skipBuild: boolean) {
    if (skipBuild) {
      return yield* new DesktopBuildCommitError({
        reason:
          "T3 Code Voice artifacts require a fresh build from the verified source snapshot; --skip-build is not supported.",
      });
    }
    return yield* resolveDesktopBuildCommit(repoRoot);
  },
);

export const applyVoiceDesktopBuildConfig = Effect.fn("applyVoiceDesktopBuildConfig")(function* (
  buildConfig: Record<string, unknown>,
  input: {
    readonly platform: string;
    readonly target: string;
    readonly version: string;
    readonly signed: boolean;
    readonly repoRoot: string;
    readonly voiceUpdate: VoiceUpdateConfig | undefined;
  },
) {
  const { platform, target, version, signed, repoRoot, voiceUpdate } = input;
  if (
    voiceUpdate &&
    (platform !== "mac" ||
      !signed ||
      !["dmg", "zip"].includes(target) ||
      !parseVoiceUpdateConfig(voiceUpdate, version))
  ) {
    return yield* new VoiceMacSigningError({
      message: "Invalid Voice self-update build configuration",
    });
  }
  const nativeVoiceVersion = voiceUpdate
    ? yield* Effect.try({
        try: () => encodeVoiceMacVersion(version),
        catch: () =>
          new VoiceMacSigningError({ message: "Unsupported Voice native macOS version" }),
      })
    : undefined;

  if (voiceUpdate?.track === "voice-candidate") {
    buildConfig.productName = "T3 Code Voice Candidate — Not Production";
  }
  // Never infer an upstream feed from repository metadata, CI variables, or mock flags.
  buildConfig.publish = voiceUpdate
    ? { provider: "generic", url: voiceUpdate.feedUrl, channel: "latest" }
    : null;
  if (voiceUpdate) {
    buildConfig.extraMetadata = { t3VoiceUpdate: voiceUpdate };
    buildConfig.generateUpdatesFilesForAllChannels = false;
  }

  if (platform === "mac") {
    const path = yield* Path.Path;
    buildConfig.afterPack = path.join(repoRoot, "scripts/mac-after-pack.ts");
    const mac = buildConfig.mac as Record<string, unknown>;
    if (voiceUpdate) {
      mac.bundleShortVersion = nativeVoiceVersion;
      const extendInfo = mac.extendInfo as Record<string, unknown>;
      extendInfo.ElectronSquirrelPreventDowngrades = true;
      if (signed) {
        mac.sign = path.join(repoRoot, "scripts/sign-voice-macos.ts");
      }
      // Builder needs a non-null identity to dispatch a custom signer without a keychain.
      mac.identity = "-";
      mac.notarize = false;
      mac.hardenedRuntime = true;
    }
  }
});
