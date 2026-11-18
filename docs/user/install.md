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
- For the native Linux x64 candidate, separately provision **Node 26.13.1**
  (ABI **147**) and, for Codex coding/Live, native **Codex CLI 0.166.0** with its
  matching resources and authorized provider setup. Neither CLI nor credentials
  are bundled. Tested on Debian 13 / glibc 2.41 only; other hosts are unverified.

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

The audited native candidate is
`t3-voice-server-0.1.10-voice.1-linux-x64-native.tar.gz`: server source `8201eb73`,
with unchanged compiled client reused from `b276408c`. It remains an unpublished
test candidate, not an available release download or a universal install proof.
Use it only when explicitly supplied for testing or attached to a published
release. Docker coding support is **unverified/not turnkey** on the tested
sandbox boundary; do not bypass Codex's sandbox to make it work.

1. Provision the pinned dependencies first, under a dedicated nonroot Linux
   account. Codex needs working kernel/user namespaces for its normal sandbox.
2. Verify the supplied archive against its adjacent `SHA256SUMS`. Extract into
   a new empty owned release directory, never over an old release. From its root,
   run `sha256sum -c PACKAGE-SHA256SUMS`. The archive's guide is **`README.md`**
   (the adjacent copy is `README-native.md`); inspect its manifests and limits.
3. Follow that guide's isolated manual start: private HOME/tmp, a separate state
   directory, and no production configuration import. The entry is
   `dist/bin.mjs serve --host 127.0.0.1 --port <server-port> --base-dir <state-dir> --no-browser`,
   invoked with the pinned Node binary. `--base-dir` contains `userdata/`; it is
   not the release directory or `userdata/` itself. Keep it separate from any
   existing upstream/fork server and choose an unused port.
4. Pair the matching Voice Mac app as a **remote client**, as below. In that
   remote environment's **Settings → Providers**, configure the native Codex
   binary and its private home; disable unused provider instances. Credentials
   stay on Linux. See [Live setup](./codex-voice.md) for the required relay;
   text-provider readiness alone does not prove Live works.

### The `t3` command

Do not use an upstream `t3` earlier on `PATH`. For the native server, run pairing
on Linux as the **same account with the same private HOME and state directory**
as the running server. Replace these example paths:

```sh
NODE=/absolute/path/to/node-v26.13.1/bin/node
RELEASE=/absolute/path/to/extracted-release
SERVER_HOME=/absolute/path/to/private-home
STATE=/absolute/path/to/private-state
env HOME="$SERVER_HOME" "$NODE" "$RELEASE/dist/bin.mjs" pair --base-dir "$STATE"
```

A loopback server needs a secure SSH tunnel from the Mac. Forward the **same**
local port to `127.0.0.1:<server-port>` on Linux so the printed loopback pairing
URL remains usable; choose a port free on both machines. Keep the tunnel open,
paste the fresh private URL into **Add environment** in the matching Voice app,
and select that remote environment before opening a project. Treat the URL as
a password; do not publish it. No public listener is needed.

For a remote-only Mac, stop local work, then turn off **Settings → Environments
→ Local environment** and confirm the app restart. This stops local agents/terminals
without removing remote environments or history; disabling one local provider
alone does not disable the local server. Confirm the Linux environment is
selected after restart. This setup is not proof of Mac microphone/playback or
end-to-end Live success. See [remote access](./remote-access.md) for connection
concepts, not upstream installation or automatic-update instructions.

## Manual updates

Download the matching newer desktop asset and server bundle from the fork
release page, verify the release checksums, back up data, and follow that
release's replacement steps. Update clients and servers together; the native
server still needs its separately pinned Node and provider CLIs.

For server migration, have the operator confirm the actual service unit,
executable, state path and service account before any cutover; these are not
verified for an existing installation by this guide. Do not assume another
host's layout. Record the old release, permissions and service configuration first. Stop the owning server/service
(and any other writer) before copying the **whole state directory**, including
SQLite WAL/SHM files if present, settings and secrets, to a restricted backup
outside the release. Do not copy only a live `statev2.sqlite`: WAL may contain
committed data. An online copy requires a supported SQLite backup API; this
candidate guide supplies no online-backup command. Back up external provider
homes and project/checkpoint data separately when needed; they are not all
inside server state. Preserve ownership and modes, including on service files;
keep backups containing secrets private.

Keep the previous release untouched. Migrate a copy of the stopped backup into
a separate private state directory using the new release; never share a state
directory between two running servers. Migration head is **96**; prior checks
covered **81→96** and **88→96**, not arbitrary data or safe downgrades. Before
cutover, confirm history, provider paths and first paired connection with the
intended service account; fresh pairing may be needed for a new isolated profile.
For rollback, stop the new server, restore the **matching pre-upgrade state,
service configuration, ownership and permissions**, then start the preserved old
release. Never run old code against newly migrated state. Production cutover,
service installation and production-state restore have not been verified here.

Published older desktop previews require manual replacement; in-app updating
has been verified between the new persistent-identity Mac candidates, but their
stable feed remains unpublished and notarization is absent. Update availability
depends on the exact release channel and artifact, not that candidate proof;
an automatic standalone server updater is not proven or shipped. Do not rely on `t3 update`, npm, or upstream
update/install commands to move a Voice installation forward. General
[update guidance](./updating.md#voice-fork-desktop-testers) explains the desktop
manual flow; the release instructions take precedence for this fork.

## Mobile app

Use a matching Voice fork build, not the stock App Store or Google Play app.
This does not promise mobile Live voice parity; see [voice limitations](./codex-voice.md).

## Providers

Configure providers in **Settings → Providers** for the environment where the
agents run. Install and authenticate their CLIs in that server environment,
and make them available on its `PATH` (or set **Binary path**).
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
