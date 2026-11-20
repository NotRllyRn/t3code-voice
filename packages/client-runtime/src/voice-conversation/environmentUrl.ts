import {
  LIVE_VOICE_PATH,
  LiveVoiceStartupError,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { PreparedConnection } from "../connection/model.ts";
import { getEnvironmentMediaStreamUrl } from "../voice-input/environment.ts";

export const supportsEnvironmentNativeLiveVoice = (
  descriptor: Pick<ExecutionEnvironmentDescriptor, "capabilities"> | null | undefined,
): boolean => descriptor?.capabilities.nativeLiveVoice === true;

export const getEnvironmentLiveVoiceUrl = (
  prepared: PreparedConnection,
  descriptor:
    | Pick<ExecutionEnvironmentDescriptor, "environmentId" | "capabilities">
    | null
    | undefined,
) =>
  Effect.suspend(() => {
    if (descriptor != null && descriptor.environmentId !== prepared.environmentId) {
      return Effect.fail(new LiveVoiceStartupError({ reason: "connection-changed" }));
    }
    if (!supportsEnvironmentNativeLiveVoice(descriptor)) {
      return Effect.fail(new LiveVoiceStartupError({ reason: "unsupported-server" }));
    }
    return getEnvironmentMediaStreamUrl(prepared, LIVE_VOICE_PATH).pipe(
      Effect.mapError(
        (error) =>
          new LiveVoiceStartupError({
            reason:
              error._tag === "EnvironmentAuthInvalidError"
                ? "environment-auth-required"
                : error._tag === "EnvironmentScopeRequiredError" ||
                    error._tag === "EnvironmentOperationForbiddenError"
                  ? "forbidden"
                  : "temporarily-unavailable",
          }),
      ),
    );
  });
