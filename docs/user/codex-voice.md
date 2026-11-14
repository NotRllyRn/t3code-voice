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
- `T3CODE_REALTIME_SECRET_REF`: JSON secret reference resolved by the existing
  configured secret-provider service. For example,
  `{"provider":"team-secrets","reference":"op://Example/Realtime/key"}`.
  Replace both fields with an existing configured provider/reference. Do not put
  the upstream key in browser settings, source, URLs, or chat.
- `T3CODE_REALTIME_VOICE`: optional voice name; defaults to `alloy`.
- `T3CODE_REALTIME_TRANSCRIPTION_MODEL`: defaults to `whisper-1`; set to an empty
  string to disable input transcription if unsupported. Manual reviewed text can
  still be queued.

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

Focused tests can run without the workspace task runner:

```sh
node --experimental-transform-types --test apps/server/src/voice/*.node-test.ts apps/web/src/voice/*.node-test.ts
```

## Not yet verified or implemented

This slice needs independent review, full workspace checks, and a real configured
upstream/browser microphone run. Focused tests are not proof of end-to-end audio.
No live credentials, production configuration, app releases, or signing settings
are part of this change.

macOS uses the shared Electron/web UI. Existing packaging already declares audio
input entitlement and microphone usage text; an actual signed macOS build and TCC
permission/device test are still required. No packaging changes were made.

Native iOS has separate Expo audio/dictation and playback interfaces; this browser
AudioWorklet implementation is not an iOS adapter. A later slice must implement
native duplex PCM capture/playback, audio focus/interruption and route handling,
and a native voice panel, using the same authenticated relay and confirmed queue
handoff. iOS browser use is explicitly disabled here.
