import { LiveConnectionError } from "@t3tools/provider-core/server/liveConnection";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { withCodexAppServerClient } from "./CodexProvider.ts";
import { makeCodexLiveConnection } from "./CodexLiveConnection.ts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

const encodePrivateLiveConfig = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const readPrivateCodexLiveConfig = Effect.fn("CodexLiveConnection.readConfig")(
  function* (input: {
    readonly binaryPath: string;
    readonly homePath: string;
    readonly launchArgs: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const { client } = yield* withCodexAppServerClient({ ...input, cwd: input.homePath });
    // Raw request avoids schema errors retaining a bearer-bearing config response.
    const response = yield* client.raw.request("config/read", { includeLayers: true });
    const encoded = yield* encodePrivateLiveConfig(response);
    if (new TextEncoder().encode(encoded).byteLength > 262144)
      return yield* new LiveConnectionError({ reason: "unsupported-provider" });
    return Redacted.make(response);
  },
  Effect.scoped,
  Effect.timeout("5 seconds"),
  Effect.mapError(() => new LiveConnectionError({ reason: "unsupported-provider" })),
);

export const makePrivateCodexLiveConnection = Effect.fn("CodexLiveConnection.makePrivate")(
  function* (input: Parameters<typeof readPrivateCodexLiveConfig>[0]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const launch = {
      ...input,
      launchArgs: resolveCodexLaunchArgs(input.launchArgs, input.environment),
    };
    return yield* makeCodexLiveConnection({
      ...launch,
      readConfig: readPrivateCodexLiveConfig(launch).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
      ),
    });
  },
);
