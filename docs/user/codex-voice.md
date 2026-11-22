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
subscription login, managed providers, profiles, and other coding providers are
currently unsupported. Supported server-owner Codex provider overrides use the
same effective configuration and existing credential as coding; project-level
connection overrides are rejected.
Use the selected provider’s HTTPS `/v1` base URL. Live uses its native `/v1/live`
endpoint, not a public Realtime WebSocket.

Live reads the selected instance's trusted Codex configuration and credential
in that environment. It does not require a separate voice key. If the configured credential uses an environment variable,
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
3. Speak your request. Final speech is saved once in the conversation. When
   coding work is requested, that same transcript enters the normal T3 queue.
   Generated paraphrases do not replace your words or add another user message.
4. Mute to turn off microphone input, or Stop to end voice capture and playback.
   Stop does not cancel a coding task. Use the normal coding Stop for that.

A draft is saved as a thread when native voice starts, before speech is admitted.
Voice stays bound to that thread while you switch chats or put the app in the
background. Other chats cannot start a second session. Typed messages, speech, coding progress
and results share that thread. Voice uses the normal coding agent and approval
UI; it cannot approve tools or answer permission requests. Check written results
and resolve questions there. Brief spoken feedback is based on actual T3 output;
its accuracy and complete audible delivery remain alpha validation requirements.

Voice replies appear in the same timeline. The coding agent receives newly
recorded voice context before its next eligible turn, with generated replies
attributed to voice. A voice-triggered turn includes context preceding its
human transcript; later replies wait for the next eligible turn. They remain
visible and are not inserted into an already-running turn. Earlier delivered
voice context is not resent on each delegation.

After a temporary disconnect, Voice tries up to four recoveries with 2, 5, 10,
and 20 second cooldowns, within a three minute recovery budget. The composer
shows reconnecting; mute stays muted. Stop or leaving the conversation cancels
recovery. Rejected credentials, permission errors and unsupported connections
stop immediately so you can correct the setting; waiting cannot repair them.

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
supported by your browser. Changes apply to the next session; recovery keeps the
current session’s choices and mute state. Native Live does not expose supported
speed or tone controls here.

By default, task feedback announces completion, blocked work, and requests for
attention. Turn on progress narration to also hear actual written coding-agent
commentary. Private reasoning is never narrated. Task notifications wait while a
native human turn is active, then resume after its final transcript. There is a
short detection boundary before the native service reports that turn; this is
not a guarantee against every interruption.

Assistant captions evolve in place until the native turn finishes. Interrupted
captions retain interruption metadata; generated text is not proof that all of
it played or was heard. Only recorded captions enter later coding-agent context.

## Fork and other surfaces

The fork is based on upstream **v0.1.10**, commit `7d32075e`. Its desktop identity
and data directory are separate (`T3 Code Voice`, `t3code-voice`, `.t3code-voice`);
older builds require manual replacement; persistent-publisher builds can use
the published fork update feed. See [Voice installation and updates](./install-voice.md).

Use matching Voice clients and servers: orchestration protocol **3** with
`voiceHistoryV1` is required. Stock upstream desktop/web clients and App Store or
Google Play mobile apps are incompatible; they cannot connect to this server.
No matching mobile client ships in this release; fork mobile/iOS work is deferred.

The current migration head is **97**. Synthetic migration checks cover
**67→97**, **81→97** and **88→97**; they do not prove arbitrary installed data
or safe downgrades. Compare installed migration names and schema before upgrading.
Back up fork data before changing builds, and do not open it with older upstream
software. Earlier private macOS artifacts passed signature checks, but are
superseded by this source cleanup. They remain self-signed and unnotarized;
Gatekeeper rejection is expected. Fresh matching artifacts, first install,
microphone, playback and the complete live journey still need acceptance.

Mobile browsers do not expose the Live control.
