// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PiSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("pi").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Pi coding agent binary.",
        providerSettingsForm: { placeholder: "pi", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to pi --mode rpc on session start.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    environmentMode: Schema.Literals(["inherit", "clean"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("inherit")),
      Schema.annotateKey({
        title: "Startup environment",
        description:
          "Clean requires dedicated directories and a trusted absolute binary path. Log in separately; no credentials are copied.",
      }),
    ),
    cleanEnvironment: Schema.optionalKey(
      Schema.Struct({
        home: TrimmedString,
        agentDirectory: TrimmedString,
        tempDirectory: TrimmedString,
        pathDirectories: Schema.Array(TrimmedString),
      }),
    ).pipe(Schema.annotateKey({ providerSettingsForm: { hidden: true } })),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "launchArgs", "environmentMode"],
  },
);
export type PiSettings = typeof PiSettings.Type;
