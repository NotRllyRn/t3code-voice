# Live Codex voice (experimental)

Talk with the selected Codex agent while keeping the normal chat composer and
coding workflow. Live voice is experimental on secure desktop browsers and the
macOS desktop app. Coding and spoken-result accuracy, natural interruption,
remote media, and macOS device behavior still need a bounded end-to-end alpha;
this is not a production-ready or verified macOS download release.

## Setup

Use a configured, unmanaged **Codex** provider in the selected T3 environment.
That instance's Codex user configuration must select a custom provider backed by
a compatible CPA native Live relay, with its existing server-side credential.
The relay must support native Live calls and media relay; an OpenAI-compatible
text endpoint or public Realtime endpoint alone is insufficient. Direct Codex
subscription login, managed providers, profiles or CLI destination overrides,
and other coding providers are currently unsupported.
Use the selected provider’s HTTPS `/v1` base URL. Live uses its native `/v1/live`
endpoint, not a public Realtime WebSocket.

Live reads the selected instance's trusted Codex configuration and credential
in that environment. It does not require `T3CODE_REALTIME_*` variables or a
separate voice key. If the configured credential uses an environment variable,
that existing variable must be available to the environment's server process;
a browser or Finder launch does not inherit a different shell's variables.
Missing credentials require fixing the selected provider setup. A successful
text chat does not establish Live availability or entitlement.

For remote use, select the environment that owns the project and provider.
Provider credentials stay on that server. Microphone and playback stay on the
client device, which also needs network access to the relay's advertised media
addresses. Use HTTPS (or localhost) and allow microphone and audio playback.
The normal authenticated environment connection and operate permission are
required; credentials and upstream destinations are never supplied by the browser.

## Use voice

1. Select a supported Codex instance in an existing thread or an empty chat draft.
   Use **Start without a project** for Scratch.
2. Start voice and wait for it to connect before speaking. The microphone is off
   while connecting or waiting for a provider refresh. Stop remains available.
3. Speak your request. Identified final speech is saved in the same conversation;
   generated delegations carry their matching final transcript into normal T3
   queue delivery. Final human corrections and constraints control the task.
4. Mute to turn off microphone input, or Stop to end voice capture and playback.
   Stop does not cancel a coding task. Use the normal coding Stop for that.

A draft is saved as a thread when native voice starts, before speech is admitted.
Opening its chat keeps voice connected. Typed messages, speech, coding progress
and results share that thread. Voice uses the normal coding agent and approval
UI; it cannot approve tools or answer permission requests. Check written results
and resolve questions there. Brief spoken feedback is based on actual T3 output;
its accuracy and complete audible delivery remain alpha validation requirements.

Stop ends capture and playback immediately. It may retain the silent media peer
while the server finishes an in-flight create and hangs up its returned call ID.
Normal cleanup has a 12-second client bound; a pending create adds up to 30 seconds.
If cleanup is not acknowledged, the app says so. A lost response without a call ID
cannot prove remote closure. Starting another call is blocked during cleanup.

Only an explicit provider refresh failure known to have created no call can
trigger one delayed retry (at least 90 seconds, within a three-minute startup
budget). Quota, rate limits, authentication errors, ordinary temporary failures
and ambiguous request losses do not retry automatically. Quota needs provider
attention; waiting does not promise credits or access. Connection, selection,
permission, navigation, unmount or page-visibility changes stop voice.

The requested alias is `gpt-live-1.1-codex`. The effective served model and version
are unknown; the alias does not establish a latest model version or entitlement.
The native Live adapter uses observed parent-turn fields whose upstream stability
and semantic accuracy are not guaranteed. Missing or stale associations fail
closed. Conflicting generated instructions are retained with their provenance;
no second executor or automatic permission bypass is used.

## Fork and other surfaces

The fork is based on upstream **v0.1.10**, commit `7d32075e`. Its desktop identity
and data directory are separate (`T3 Code Voice`, `t3code-voice`, `.t3code-voice`);
updates are manual. See [Voice installation and updates](./install.md).

Use matching Voice clients and servers: orchestration protocol **3** with
`voiceHistoryV1` is required. Stock upstream desktop/web clients and App Store or
Google Play mobile apps are incompatible; they cannot connect to this server.
A matching fork mobile build is required, not an automatic store upgrade.

The current migration head is **96**. Migration checks covered legacy upstream
**81→96** and earlier fork **88→96** data; they do not prove downgrades are safe.
Back up fork data before changing builds, and do not open it with older upstream
software. No exact macOS artifact has yet passed the required Finder,
microphone, playback, signing/notarization and download checks for this candidate.

Native mobile voice and the retained legacy Realtime transport are separate
paths. Their older setup does not configure desktop Live and is not a fallback.
Mobile browsers are disabled for this Live control. No mobile parity is claimed.
