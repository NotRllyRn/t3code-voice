# Install T3 Code Voice

T3 Code Voice is an experimental fork for voice prompts and spoken replies.
Use matching Voice clients and servers from the
[fork releases](https://github.com/NotRllyRn/t3code-voice/releases), following
that release's instructions and checksums. An artifact is available only when
attached to a published release.

## Requirements

- A matching Voice client and server. This fork requires orchestration protocol
  **3** and `voiceHistoryV1`; stock upstream desktop/web clients and the App Store
  and Google Play apps cannot connect. Use a matching fork mobile build instead.
- Installed, authenticated providers on the machine running the server. A server
  bundle alone does not include provider CLIs or their credentials.
- For the Docker server bundle, a **separate pinned Node image** specified by the
  release, plus provider CLIs and authentication inside the server environment.
  The bundle is not a self-contained Docker image or standalone executable.

Do not use upstream `t3.codes` installers, Homebrew/store packages, or `npx t3`
for this fork. Voice versions are not published as the upstream npm `t3` package.

## Desktop app

Download the matching Voice desktop asset from the fork release page. Current
macOS tester builds are experimental, ad-hoc signed and manually installed,
not Developer ID signed or notarized. Gatekeeper can block launch; do not treat
an available download as proof of macOS trust or microphone compatibility.
Read the release's trust limits before installing.

Quit the app before replacing it. Keep a backup of the fork's data directory
(`~/.t3code-voice`) before changing builds; do not overwrite an upstream profile.
First launch, microphone, playback and Keychain behavior still need testing on
your Mac. Manual replacement may prompt again for microphone or Keychain access.

## Command line

For a remote server, use the release's manual Docker bundle instructions. Supply
its pinned Node image separately, install/authenticate the providers you need,
and persist the data and credentials as directed there. Do not substitute an
upstream server or assume a canonical CLI archive or fork `install.sh` exists.

### The `t3` command

Run commands such as `t3 pair` only through the matching Voice runtime supplied
by your installation. An upstream `t3` earlier on `PATH` is not interchangeable.
See [remote access](./remote-access.md) for connection concepts; its upstream
install and automatic-update instructions do not install this fork.

## Manual updates

Download the matching newer desktop asset and server bundle from the fork
release page, verify the release checksums, back up data, and follow that
release's replacement steps. Update clients and servers together. The Docker
server still needs the separately pinned Node image, provider CLIs and auth.

Desktop **Check for Updates** can offer a fork download for manual replacement;
it does not automatically upgrade the app. An automatic standalone server
updater is not proven or shipped. Do not rely on `t3 update`, npm, or upstream
update/install commands to move a Voice installation forward. General
[update guidance](./updating.md#voice-fork-desktop-testers) explains the desktop
manual flow; the release instructions take precedence for this fork.

## Mobile app

Use a matching Voice fork build, not the stock App Store or Google Play app.
This does not promise mobile Live voice parity; see [voice limitations](./codex-voice.md).

## Providers

Configure providers in **Settings → Providers** for the environment where the
agents run. Install and authenticate their CLIs there, including inside a Docker
server environment, and make them available on its `PATH` (or set **Binary path**).
Do not put credentials in images or published bundles.

Provider setup: [Codex](./providers-codex.md), [Claude](./providers-claude.md),
[OpenCode](./providers-opencode.md), [Antigravity](./providers-antigravity.md),
[Kiro](./providers-kiro.md), [Pi](./providers-pi.md),
[Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

### Provider check timeouts

If an authenticated CLI works directly but its readiness check times out, set
`T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` or `T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000`
in the server environment as appropriate, then restart it. These settings extend
readiness checks, not turn execution or installation deadlines. A longer timeout
also takes longer to report a stalled provider.

## Next steps

- [Voice setup and limits](./codex-voice.md)
- [Working with threads](./thread-sidebar.md)
- [Permission modes](./permission-modes.md)
- [Remote access](./remote-access.md)
