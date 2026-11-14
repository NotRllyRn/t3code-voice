# Codex voice conversation (initial slice)

A separate push-to-talk conversation in the web composer. It does not read coding
history, run tools, or control the coding runtime. Select a saved Codex thread with
its current model, then open **Voice conversation**. Start, record a short turn,
and send it for a spoken reply. Stop releases the microphone. Mute discards an
unfinished turn; Interrupt stops only voice playback/generation.

To send work to coding, choose **Use my transcript** or type a request, review it,
and press **Confirm and queue to coding thread**. Nothing is sent automatically.
This uses the normal `message.dispatch` queue and approval rules, never steer or
restart. A failed-delivery retry keeps the same command/message identity.

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
The server checks operate scope, the saved thread, and its Codex provider.
Missing/invalid server setup fails closed; Start does not fall back to dictation.

The upstream must support the GA Realtime session shape: PCM16 mono at 24 kHz,
explicit input commits and response creation, session-update acknowledgment,
response identities/metadata, cancellation, and audio truncation. Both common
WS audio-event spellings are accepted. This is not a universal provider adapter.
Tools and browser-supplied session settings/text/upstream endpoints are rejected.
Upstream errors and unneeded event fields are not forwarded to the browser.

## Current limits and checks

- One voice connection per authenticated app session; no reconnect/replay.
- Stop on owner/model/provider switch, panel close/unmount, permission/focus loss,
  page hide, or tab hiding. Backend ownership is also checked every two seconds.
- 14-second UI recording limit; server enforces 15 seconds of audio per turn,
  32 response requests, bounded frames/command rate, and ten minutes per socket.
- Playback is bounded to eight queued seconds; overflow stops rather than buffering
  indefinitely. Interrupted audio is flushed locally and truncated conservatively
  using consumed samples minus estimated device latency.
- Only the latest bounded transcript/reply is displayed. It is local panel state,
  not saved chat history. No coding output is spoken automatically.

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

Native iPhone source now includes a local AVFoundation PCM module, the shared
conversation controller, and an explicit confirmed queue handoff. It requires a
rebuilt iOS development client; missing modules remain unavailable, not dictation
fallbacks. Backgrounding, audio interruption/route changes, or owner changes stop
voice without automatic resume. Android conversation voice remains hidden.
Swift/Xcode compilation, native engine/timing tests, simulator checks, and a
physical iPhone microphone/speaker run are still required. This is not a release
or an installable signed iPhone build. iOS browser use remains disabled.
