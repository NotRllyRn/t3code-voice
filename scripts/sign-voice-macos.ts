import type { SignOptions } from "@electron/osx-sign";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { extractFile } from "@electron/asar";
import { Effect, Path, Schema } from "effect";
import { signVoiceMacApp, VoiceMacSigningError } from "./lib/voice-mac-signing.ts";

const decodePackageVersion = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

export default async function sign(options: SignOptions): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const packageJson = yield* Effect.try({
        try: () =>
          extractFile(
            path.join(options.app, "Contents/Resources/app.asar"),
            "package.json",
          ).toString("utf8"),
        catch: () => new VoiceMacSigningError({ message: "Cannot read packaged Voice version" }),
      });
      const { version } = yield* decodePackageVersion(packageJson);
      yield* signVoiceMacApp(
        options.app,
        yield* path.fromFileUrl(new URL("..", import.meta.url)),
        version,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
