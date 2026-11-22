# Install T3 Code Voice

T3 Code Voice is an experimental fork for voice prompts and spoken replies.
Use matching Voice clients and servers from the
[fork releases](https://github.com/NotRllyRn/t3code-voice/releases), following
that release's instructions and checksums. An artifact is available only when
attached to a published release.

## Requirements

- A matching Voice client and server. This fork requires orchestration protocol
  **3** and `voiceHistoryV1`; stock upstream desktop/web clients and the App Store
  and Google Play apps cannot connect. This release supports macOS and the
  web client with its matching server; mobile/iOS fork support is deferred.
- Installed, authenticated providers on the machine running the server. A server
  bundle alone does not include provider CLIs or their credentials.
- The native Linux x64 bundle embeds **Node 26.13.1** (ABI **147**); no separate
  Node is needed to start it. For Codex coding/Live, provision native
  **Codex CLI 0.166.0**, its resources and authorized provider setup separately.
  Provider CLIs and credentials are not bundled. Debian 13 / glibc 2.41 is the
  packaging baseline; native-library compatibility on other hosts is unverified.

Do not use upstream `t3.codes` installers, Homebrew/store packages, or `npx t3`
for this fork. Voice versions are not published as the upstream npm `t3` package.

## Desktop app

Download the matching Voice desktop asset from the fork release page. Published
macOS Voice builds use a persistent private self-signed publisher, not Apple
Developer ID signing or notarization. Gatekeeper can block launch; do not treat
an available download as proof of macOS trust or microphone compatibility.
Read the release's trust limits before installing.

Quit the app before replacing it. Keep a backup of the fork's data directory
(`~/.t3code-voice`) before changing builds; do not overwrite an upstream profile.
First launch, microphone, playback and Keychain behavior still need testing on
your Mac. Manual replacement may prompt again for microphone or Keychain access.

## Command line

Use the archive and upgrade guide attached to the selected release. Keep the
previous release and a matching state backup for rollback.
Docker coding support is **unverified/not turnkey** on the tested
sandbox boundary; do not bypass Codex's sandbox to make it work.

1. Provision the pinned dependencies first, under a dedicated nonroot Linux
   account. Codex needs working kernel/user namespaces for its normal sandbox.
2. Verify the supplied archive against its adjacent `SHA256SUMS`. Extract into
   a new empty owned release directory, never over an old release. From its root,
   verify the extracted files against the supplied `PACKAGE-SHA256SUMS`.
   The adjacent `INSTALL-BACKUP-ROLLBACK.md` and manifests describe this bundle.
3. Follow that guide's isolated manual start: private HOME/tmp, a separate state
   directory, and no production configuration import. The entry is
   `./t3 serve --host 127.0.0.1 --port <server-port> --base-dir <state-dir> --no-browser`.
   Keep `client/`, `node_modules/`, `resource-monitor/` and `lib/` beside `t3`;
   copying only the executable breaks the distribution. `--base-dir` contains `userdata/`; it is
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
RELEASE=/absolute/path/to/extracted-release
SERVER_HOME=/absolute/path/to/private-home
STATE=/absolute/path/to/private-state
env HOME="$SERVER_HOME" "$RELEASE/t3" pair --base-dir "$STATE"
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

## Updates and rollback

Download the matching newer desktop asset and server bundle from the fork
release page, verify the release checksums, back up data, and follow that
release's replacement steps. Update clients and servers together; the native
server embeds Node but still needs separately installed provider CLIs.

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
directory between two running servers. Migration head is **103**. Synthetic
**67→103**, **81→103**, **88→103** and **97→103** checks preserve saved conversation payloads;
these do not prove every production data shape or safe downgrades. Compare the
installed migration IDs/names and schema with the source at its recorded head
before cutover; the head number alone does not prove compatibility. Voice.8
keeps `97_ScheduledTaskGeneration`; upstream issue-tracker bindings run at
`103_IssueTrackerBindings`. Stock upstream databases are not an in-place
Voice upgrade path. Before
cutover, confirm history, provider paths and first paired connection with the
intended service account; fresh pairing may be needed for a new isolated profile.
For rollback, stop the new server, restore the **matching pre-upgrade state,
service configuration, ownership and permissions**, then start the preserved old
release. Never run old code against newly migrated state. Production cutover,
service installation and production-state restore have not been verified here.

Persistent-identity macOS Voice builds can discover the fork's `voice-stable`
feed and download, install and relaunch a compatible newer Voice release.
Voice.6 delivery was verified from pristine Voice.4 and local Voice.5 copies.
That fixture proof does not establish encrypted credential continuity: macOS may
request Keychain permission. Signing remains self-signed and unnotarized.

Voice.6 adds validated fork archive discovery for server updates through the
existing background-service launcher. Earlier servers may need the release's
manual bootstrap guide. A server must advertise the required update capability
and pass authorization, checksum and compatibility checks; an arbitrary process
started with `serve` is not automatically a managed service. Isolated launcher
upgrade and rollback were tested; production service cutover remains manual.
Use the installed app's update controls or the exact release guide. Do not use
upstream npm/install commands to upgrade Voice. An unavailable release check
is not proof that every connected environment is current.

## Mobile app

Mobile/iOS fork work is deferred. The repository retains upstream mobile code;
this release does not ship a matching mobile client. Stock store apps are not
compatible with the Voice server. See [voice limitations](./codex-voice.md).

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
