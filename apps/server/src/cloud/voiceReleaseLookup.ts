import { ServerNpmReleaseError } from "@t3tools/contracts";
import { cliReleaseIndexPageUrl } from "@t3tools/shared/cliRelease";
import { selectVoiceRelease } from "@t3tools/shared/voiceRelease";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";

const VoiceReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    html_url: Schema.String,
    draft: Schema.optionalKey(Schema.Boolean),
    prerelease: Schema.optionalKey(Schema.Boolean),
    assets: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        browser_download_url: Schema.String,
        content_type: Schema.String,
        digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
const decodeVoiceReleaseIndex = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceReleaseIndex),
);

/** Local release fixtures must never redirect discovery or credentials to another host. */
export function voiceReleaseTestIndexUrl(value: string): string | undefined {
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})(?:\/[^\s?#\\]*)?$/.exec(value);
  return match && Number(match[1]) <= 65535 ? value : undefined;
}

export const lookupVoiceRelease = Effect.fn("NpmRelease.lookupVoice")(function* (input: {
  readonly http: HttpClient.HttpClient;
  readonly runtimeVersion: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}) {
  const { http, runtimeVersion, environment, platform, arch } = input;
  const fixture = environment.T3CODE_VOICE_RELEASE_TEST_INDEX_URL;
  if (fixture !== undefined && voiceReleaseTestIndexUrl(fixture) === undefined) {
    return yield* new ServerNpmReleaseError({
      reason: "Invalid loopback Voice release test index URL.",
    });
  }
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(fixture ?? cliReleaseIndexPageUrl(page));
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const releases = yield* http.get(url.toString()).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.gen(function* () {
              let bytes = 0;
              const chunks = yield* response.stream.pipe(
                Stream.mapEffect((chunk) => {
                  bytes += chunk.byteLength;
                  return bytes <= 8 * 1024 * 1024
                    ? Effect.succeed(chunk)
                    : Effect.fail(
                        new ServerNpmReleaseError({
                          reason: "Voice release metadata is too large.",
                        }),
                      );
                }),
                Stream.runCollect,
              );
              const decoder = new TextDecoder();
              return (
                chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
                decoder.decode()
              );
            })
          : Effect.fail(
              new ServerNpmReleaseError({ reason: "Could not read Voice release metadata." }),
            ),
      ),
      Effect.flatMap(decodeVoiceReleaseIndex),
      Effect.timeout(Duration.seconds(15)),
      Effect.mapError(
        () => new ServerNpmReleaseError({ reason: "Could not read Voice release metadata." }),
      ),
    );
    const selected = selectVoiceRelease(runtimeVersion, releases, {
      kind: "cli-archive",
      platform,
      arch,
    });
    if (selected.status === "offered") return { version: selected.version };
    if (releases.length < 100) break;
  }
  return null;
});
