# Live Codex voice (experimental)

Talk with any selected coding agent while keeping the normal chat composer and
coding workflow. Live voice is experimental on secure desktop browsers and the
macOS desktop app. Spoken replies are model-generated; check the written coding
result when accuracy matters. Browser audio checks do not establish physical
microphone, speaker, or macOS Keychain behavior.

## Setup

Enable a configured, unmanaged **Codex** provider for voice in the selected T3 environment.
That instance's Codex user configuration must select a custom provider backed by
a compatible CPA native Live relay, with its existing server-side credential.
The relay must support native Live calls and media relay; an OpenAI-compatible
text endpoint or public Realtime endpoint alone is insufficient. Direct Codex
subscription login, managed providers, and profiles are unsupported for voice.
The coding agent can use any enabled provider, including Claude, Antigravity,
Cursor, OpenCode, and Pi. Supported server-owner Codex provider overrides use the
same effective configuration and existing credential as coding; project-level
connection overrides are rejected.
Use the voice provider’s HTTPS `/v1` base URL. Live uses its native `/v1/live`
endpoint, not a public Realtime WebSocket.

Live reads the voice instance's trusted Codex configuration and credential
in that environment. It does not require a separate voice key. If the configured credential uses an environment variable,
that existing variable must be available to the environment's server process;
a browser or Finder launch does not inherit a different shell's variables.
Missing credentials require fixing the Codex voice provider setup. A successful
text chat does not establish Live availability or entitlement.

When the coding provider is Codex, Live tries that instance first. Otherwise,
or if it cannot resolve a voice connection, Live tries other enabled Codex
instances in instance ID order. Coding keeps the selected provider and model.

For remote use, select the environment that owns the project and providers.
Provider credentials stay on that server. Microphone and playback stay on the
client device, which also needs network access to the relay's advertised media
addresses. Use HTTPS (or localhost) and allow microphone and audio playback.
The normal authenticated environment connection and operate permission are
required; credentials and upstream destinations are never supplied by the browser.

## Use voice

1. Select any enabled coding provider in an existing thread or an empty chat draft.
   Use **Start without a project** for Scratch.
2. Start voice and wait for it to connect before speaking. The microphone is off
   while connecting or waiting for a provider refresh. Stop remains available.
3. Speak your request. Final speech is saved once in the conversation. When
   coding work is requested, that same transcript enters the normal T3 queue.
   Generated paraphrases do not replace your words or add another user message.
4. Mute to turn off microphone input, or Stop to end voice capture and playback.
   Stop does not cancel a coding task. Use the normal coding Stop for that.

Muting stops new microphone capture locally. An already identified spoken turn
can still finish transcription and receive its reply. The relay does not provide
a shared audio/mute cutoff: a turn first reported after mute may be dropped,
and provider-generated extra audio cannot be ruled out. Use Stop to end playback.

Final spoken task requests steer an active coding turn through its normal delivery
policy. With no active turn they start normally; queued voice requests can also
use **Send now**. The original transcript stays unchanged.

A draft is saved as a thread when native voice starts, before speech is admitted.
Voice stays bound to that thread while you switch chats or put the app in the
background. Other chats cannot start a second session. Typed messages, speech, coding progress
and results share that thread. Voice uses the normal coding agent and approval
UI; it cannot approve tools or answer permission requests. Check written results
there. While Live is connected, speak a custom answer to the visible question card.
Final transcription fills and advances that question; the last answer submits
the card. Typing and options still work. Editing an answer or switching cards
discards an older pending spoken answer. Permission requests always require
the normal UI. Brief spoken feedback is based on actual T3 output;
its accuracy and complete audible delivery remain alpha validation requirements.

Voice replies appear in the same timeline. The coding agent receives newly
recorded voice context before its next eligible turn, with generated replies
attributed to voice. A voice-triggered turn includes context preceding its
human transcript; later replies wait for the next eligible turn. They remain
visible and are not inserted into an already-running turn. Earlier delivered
voice context is not resent on each delegation. If supplemental voice history
does not fit the current model context, it waits; your reply can continue in
the existing coding session.

After a temporary disconnect, Voice tries up to four recoveries with 2, 5, 10,
and 20 second cooldowns, within a three minute recovery budget. The composer
shows reconnecting; mute stays muted. Stop or quitting the app cancels
recovery. Rejected credentials, permission errors and unsupported connections
stop immediately so you can correct the setting; waiting cannot repair them.

Saved history is background context, not a new user request to speak. Recovery
keeps the latest available user request and coding result alongside recent voice
replies, within its bounded history window.

Recovery keeps the same conversation and follows its pending tasks without
rerunning them or approving anything. Results completed while disconnected can
be sent for narration after recovery. Acknowledged result notifications are not
repeated, but successful submission to voice is not proof that audio was heard.
Recovery tracks up to 32 pending tasks; exceeding that limit stops voice with an
error while coding tasks continue normally.

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
permission or provider ownership changes can stop voice; navigating between chats
or hiding the app does not. Quit the app or use Stop to end the session.

The requested alias is `gpt-live-1.1-codex`. The effective served model and version
are unknown; the alias does not establish a latest model version or entitlement.
The native Live adapter uses observed parent-turn fields whose upstream stability
and semantic accuracy are not guaranteed. Missing or stale associations fail
closed. Delegation keeps its internal correlation to the recorded human turn;
generated instructions are not submitted as human input. No second executor or
automatic permission bypass is used.

## Live Voice settings

In **Settings → Live Voice**, choose a native voice and microphone/speaker where
supported by your browser. Voice and device changes apply to the next session;
recovery keeps those choices and mute state. Native Live does not expose supported
speed or tone controls here.

By default, task feedback announces completion, blocked work, and requests for
attention. Turn on **Read progress aloud** to also hear actual written coding-agent
commentary. This switch also updates an active session. With it off, routine
written updates stay in the chat rather than being sent for voice narration.
Ask the coding agent for fresh status between announcements; the voice model
does not continuously receive silent task updates. Private reasoning is never
narrated. Task notifications wait while a
native human turn is active, then resume after its final transcript. There is a
short detection boundary before the native service reports that turn; this is
not a guarantee against every interruption.

Assistant captions evolve in place until the native turn finishes. Interrupted
captions retain interruption metadata; generated text is not proof that all of
it played or was heard. Only recorded captions enter later coding-agent context.

## Fork and other surfaces

The fork is based on upstream **v0.1.11**, commit `59651c1761`. Its desktop identity
and data directory are separate (`T3 Code Voice`, `t3code-voice`, `.t3code-voice`);
older builds require manual replacement; persistent-publisher builds can use
the published fork update feed. See [Voice installation and updates](./install-voice.md).

Use matching Voice clients and servers: orchestration protocol **3** with
`voiceHistoryV1` is required. Stock upstream desktop/web clients and App Store or
Google Play mobile apps are incompatible; they cannot connect to this server.
No matching mobile client ships in this release; fork mobile/iOS work is deferred.

The current migration head is **103**, unchanged from Voice.1. Test a private
copy of your stopped server's data before cutover; matching migration numbers
do not prove compatibility with arbitrary installations or safe downgrades.
Back up fork data before changing builds, and do not open it with older upstream
software. macOS packages use a persistent self-signed publisher and are not
Apple-notarized; first installation may require macOS approval.

Mobile browsers do not expose the Live control.
