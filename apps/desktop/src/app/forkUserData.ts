import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

// Fork profiles never inspect or migrate another app's credentials or browser state.
export const resolveForkUserDataPath = Effect.fn("desktop.userData.resolveForkUserDataPath")(
  function* (input: { readonly appDataDirectory: string; readonly isDevelopment: boolean }) {
    const path = yield* Path.Path;
    return path.join(
      input.appDataDirectory,
      input.isDevelopment ? FORK_DESKTOP.developmentProfileName : FORK_DESKTOP.profileName,
    );
  },
);
