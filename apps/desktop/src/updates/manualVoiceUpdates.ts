import { FORK_RELEASE } from "@t3tools/shared/forkIdentity";
import { selectVoiceRelease } from "@t3tools/shared/voiceRelease";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";

const RELEASES_API = `https://api.github.com/repos/${FORK_RELEASE.repository}/releases?per_page=100`;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CHECK_TIMEOUT_MS = 10_000;
const TARGET = { kind: "desktop-dmg", platform: "darwin", arch: "arm64" } as const;
const Releases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    html_url: Schema.String,
    draft: Schema.Boolean,
    prerelease: Schema.Boolean,
    assets: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        browser_download_url: Schema.String,
        content_type: Schema.String,
      }),
    ),
  }),
);

type ManualVoiceUpdate =
  | { readonly status: "offered"; readonly version: string; readonly url: string }
  | { readonly status: "unavailable"; readonly detail: string };

export interface ManualVoiceUpdateInput {
  readonly currentVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
}

export async function discoverManualVoiceUpdate(
  input: ManualVoiceUpdateInput,
  fetchReleases: typeof fetch = fetch,
): Promise<ManualVoiceUpdate> {
  const unavailable = (detail: string): ManualVoiceUpdate => ({ status: "unavailable", detail });
  if (!input.isPackaged || input.isDevelopment) {
    return unavailable("Development builds cannot check for an installed Voice update. Use a packaged Voice release.");
  }
  if (input.platform !== "darwin" || input.arch !== "arm64") {
    return unavailable("Manual Voice downloads currently support Apple Silicon macOS (arm64) only. No compatible build is offered for this app.");
  }
  if (selectVoiceRelease(input.currentVersion, [], TARGET).status === "invalid-current") {
    return unavailable("This app version is not a recognized Voice release. Install a packaged Voice release before checking again.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetchReleases(RELEASES_API, {
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable(
        response.status === 403 || response.status === 429
          ? "GitHub refused this check or its rate limit was reached. Try again later."
          : "The fork release service is unavailable. Try again later.",
      );
    }
    if (!response.body) return unavailable("GitHub returned an empty release response. Try again later.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return unavailable("The fork release response is too large. Try again later.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const releases = Schema.decodeUnknownSync(Releases)(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (releases.length > 100 || releases.some((release) => release.assets.length > 100)) {
      return unavailable("The fork release response exceeds supported limits. Try again later.");
    }
    const selected = selectVoiceRelease(input.currentVersion, releases, TARGET);
    if (selected.status !== "offered") {
      return unavailable("No newer compatible Voice DMG was found in the latest 100 fork releases. This does not confirm that all components are up to date.");
    }
    return { status: "offered", version: selected.version, url: selected.asset.url };
  } catch {
    return unavailable(
      controller.signal.aborted
        ? "The fork release check timed out. Check your connection and try again."
        : "Could not read fork releases. Check your connection and try again later.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const checkManualVoiceUpdate = Effect.fn("desktop.updates.checkManualVoice")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const policy = yield* DesktopUpdatePolicy.DesktopUpdatePolicy;
  if (policy.mode === "off" || policy.feedUrl !== undefined) {
    yield* dialog.showMessageBox({
      type: "info",
      title: "Voice updates unavailable",
      message: policy.message ?? "Managed update settings do not allow this fork release check.",
      buttons: ["OK"],
    });
    return;
  }
  const result = yield* Effect.promise(() => discoverManualVoiceUpdate({
    currentVersion: environment.appVersion,
    platform: environment.platform,
    arch: environment.processArch,
    isPackaged: environment.isPackaged,
    isDevelopment: environment.isDevelopment,
  }));
  const answer = yield* dialog.showMessageBox({
    type: "info",
    title: "T3 Code Voice manual updates",
    message: result.status === "offered" ? `Voice ${result.version} is available.` : "Voice update check",
    detail: result.status === "offered"
      ? "Download the Apple Silicon DMG from the fork's GitHub release, then install it manually. Downloading does not establish Apple Developer ID signing or notarization. Automatic installation remains disabled pending trusted signing and update verification. Save your work before replacing the app."
      : result.detail,
    buttons: result.status === "offered" ? ["Cancel", "Download Voice DMG"] : ["OK"],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.status === "offered" && answer.response === 1) {
    const shell = yield* ElectronShell.ElectronShell;
    if (!(yield* shell.openExternal(result.url))) {
      yield* dialog.showMessageBox({
        type: "warning",
        title: "Could not open download",
        message: "The browser could not open the Voice DMG download. Try checking again later.",
        buttons: ["OK"],
      });
    }
  }
});
