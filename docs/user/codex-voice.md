# Continuous Codex voice prototype (web/macOS)

A conversational voice front end for the selected **T3 Codex agent**, using the
environment's configured Realtime transport. This is a prototype, not native Codex
voice parity or a production release.

## Fork base and updates

The voice fork is based on upstream **v0.1.9**, commit
`24e77473ecf41bc1f7142529c7911c1c1aae1d76`, not moving upstream main.
Desktop identity, profile, data directory and URL schemes are fork-owned
(`T3 Code Voice`, `t3code-voice`, `.t3code-voice`). Updates remain manual.
The stable port retains migration IDs 82–88 from earlier fork previews so their
existing databases remain readable; this is not an upstream development merge.
No saved voice history is deleted or reset by this port. Back up the fork data
directory before trying a different build; do not run an older upstream build
against a fork preview database.

GPT-Live protocol/authentication work is not part of this stable port. The
Realtime prototype below remains the existing implementation, not a Live fallback.

1. Select one Codex model in an existing thread or an empty new-chat draft. For no
   project, use the normal **Start without a project** action to open Scratch.
2. Press **Start voice**, allow the microphone, then speak normally. Server VAD
   detects turns; there is no Record/End button or per-turn text confirmation.
3. Work and contextual questions are delegated through a bounded Realtime function
   to normal T3 thread launch/message delivery. A draft creates its saved thread
   lazily on the first delegated utterance. No typed message is needed.
4. Speak over a reply to stop speech and start another voice turn. **Mute mic**
   discards unfinished input; **Stop voice** releases audio. Neither stops coding.

T3 remains the only coding runtime. Its actual run states and bounded final reply
feed back to the voice model; acceptance is not reported as successful work.
Existing-thread history is limited to recent user/assistant snippets. Approvals
and questions stay in the normal chat UI; voice cannot grant permissions. A draft
shows an **Open coding thread** link for that UI (navigation stops voice).
Messages use normal queue delivery, not steer/restart. No automatic replay/retry
is attempted after an ambiguous failure.

## Server setup

Configure the environment's server, not the browser:

- `T3CODE_REALTIME_URL`: complete OpenAI-compatible Realtime WebSocket URL, including
  its model query parameter. For example,
  `wss://realtime.example/v1/realtime?model=example-realtime`.
- Configure exactly one server-side credential source:
  - `T3CODE_REALTIME_API_KEY_FILE`: absolute path to a small UTF-8 file containing
    only the upstream API key, optionally followed by one LF or CRLF newline.
    No external secret manager or `op` CLI is required.
  - `T3CODE_REALTIME_SECRET_REF`: JSON secret reference resolved by the existing
    configured secret-provider service. For example,
    `{"provider":"team-secrets","reference":"op://Example/Realtime/key"}`.
    Replace both fields with an existing configured provider/reference.
- `T3CODE_REALTIME_VOICE`: optional voice name; defaults to `alloy`.
- `T3CODE_REALTIME_TRANSCRIPTION_MODEL`: defaults to `whisper-1`. An unset or
  empty environment value uses that default; empty does not disable transcription.
  Use an endpoint that supports the configured transcription model.

Create the key file outside the repository in a private directory. On Linux and
macOS it must be a regular file owned by the server's OS user with mode `0600`
(or read-only `0400`). The server checks the resolved target, so a symlink to a
suitable file is allowed. Keep its parent directories trusted and do not replace
the file while it is being read. On Windows the server checks regular-file type
and size but not POSIX ownership/mode bits: restrict access with Windows ACLs to
the server user and administrators before launching. Do not use a shared folder.
Files larger than 4096 bytes, empty keys, spaces, non-ASCII bytes, and control
characters inside the key are rejected.

Set the path, not the key, in the launch environment, then start the server
normally. These fictional paths assume you have already provisioned the file:

```bash
export T3CODE_REALTIME_URL='wss://realtime.example/v1/realtime?model=example-realtime'
unset T3CODE_REALTIME_API_KEY T3CODE_REALTIME_SECRET_REF
export T3CODE_REALTIME_API_KEY_FILE='/private/server-secrets/realtime-key'
```

For a managed server, set the same variables in its service environment and
restart it. Remove the obsolete `T3CODE_REALTIME_API_KEY` from every launch source;
its presence, **even empty**, disables voice with a sanitized failure. This does
not remove an existing raw key from the process environment or prevent its
inheritance by unrelated children. Never launch with it set.

There is no precedence or fallback: if both file and reference variables are set
(even if one is empty), or neither is set, voice Start fails with an empty `503`
response before either source is read. File errors and secret-reference resolution
failures also fail closed. Restart after changing launch configuration.

Keep credentials out of tracked files, browser settings, URLs, CLI arguments, and
chat. The server reads and redacts file contents only for voice, never exports
those contents into the environment, and sends the key only in the upstream Bearer
header, not to the browser or logs. The path can be inherited by providers and
other child processes; a process with the same OS user's access can deliberately
read the file. This prevents automatic raw-value propagation through environments;
it is not a provider sandbox or protection from the server owner/administrators.
The browser cannot select a file path, environment name, or credential source.

The endpoint must use `wss:`; plain `ws:` is allowed only on loopback. The relay
adds a server-side Bearer header. There is no account-token extraction, direct
subscription-auth fallback, or service-specific branch. The browser uses the
existing authenticated environment connection and short-lived media ticket.
The server checks operate scope, the bound thread or draft, and its Codex provider.
Missing/invalid server setup fails closed; Start does not fall back to dictation.

The upstream must support the GA Realtime session shape: PCM16 mono at 24 kHz,
server VAD with automatic responses disabled, finalized input transcription,
explicit response creation, function-call arguments/output, session-update
acknowledgment, response identities/metadata, cancellation, and audio truncation.
Both common WS audio-event spellings are accepted. This is not a universal adapter.
The only voice function has zero arguments: the server owns its finalized
transcript and target. Browser-supplied tools, text, session settings, credentials,
and upstream endpoints are rejected. Unneeded upstream fields are not forwarded.

## Current limits and checks

- One voice connection per authenticated app session; no reconnect/replay.
- Stop on owner/model/provider switch, panel unmount, permission/connection loss,
  page hide, or tab hiding. Backend ownership is also checked every two seconds.
- Ten minutes per socket, 64 finalized utterances, 96 voice responses, 16 pending
  responses, and bounded frames/command rate. Voice replies use a 512-token limit.
- Playback uses the bounded 120-second compact PCM spool with a short worklet
  window. The next response waits for actual consumed-sample playback completion,
  not merely generation completion. Barge-in flushes/truncates conservatively at
  consumed samples minus estimated device latency.
- Progress is run state, not raw tools/logs. Final result context is capped at 8,000
  characters for recent runs and marked as this turn only: background work may
  still be running. Result data is untrusted conversation content, not instructions.
- Only the latest bounded transcript/reply is displayed locally. Delegated requests
  and coding replies are saved by the normal T3 pipeline. A draft's typed text,
  attachments, and worktree-launch settings are not sent by voice; voice launches
  the selected project's normal root workspace (or managed Scratch).

Focused server tests can run without the workspace task runner:

```sh
cd apps/server
../../node_modules/.bin/vp test run src/voice
```

## Not yet verified or implemented

This slice needs independent review, full workspace checks, and a real configured
upstream/browser microphone run. Focused tests are not proof of end-to-end audio.
No live credentials, production configuration, app releases, or signing settings
are part of this change.

macOS uses the shared Electron/web UI. Existing packaging already declares audio
input entitlement and microphone usage text; an actual signed macOS build and TCC
permission/device test are still required. No packaging changes were made.

This continuous prototype does not change native mobile voice. Its older confirmed
handoff path is separate and has not been validated here. iOS browser use remains
disabled; no iOS/native build or release is part of this task.
