# T3 Code Voice Mobile

This fork connects directly to a T3 Code server using host/code or QR pairing. Cloud
sign-in is optional. It uses native modules, so Expo Go is not supported.

## Local iOS builds

Use a Mac with Xcode and the existing project dependencies. Run commands from
`apps/mobile`, in an isolated source copy without real `.env` or `.env.local` files.
Do not copy credentials into the source or run EAS submit for this fork.

Defaults are **T3 Code Voice**, bundle ID `io.github.notrllyrn.t3codevoice`, scheme
`t3code-voice`, and Expo slug `t3code-voice`. `APP_VARIANT=development` adds `.dev`
to the bundle ID and `-dev` to the scheme; `preview` adds `.preview` and `-preview`.
No Apple Team, Expo owner/project, OTA URL, or associated domains are configured.
OTA stays disabled, including when `T3CODE_MOBILE_UPDATES_ENABLED=1` is supplied.

Before prebuild, have the fork config independently reviewed and inspect the resolved
manifest without contacting Expo or reading env files:

```bash
EXPO_NO_DOTENV=1 EXPO_OFFLINE=1 vp exec expo config --type introspect
```

`EXPO_NO_DOTENV=1` skips both Expo's dotenv loader and this app config's repository
loader. Keep cloud variables unset for a direct-server-only build. An intentional
cloud deployment can still provide its own `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`,
`EXPO_PUBLIC_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`; that does not add universal
links, passkey domains, or native Sign in with Apple support to a Personal Team build.
The normal repository loader also accepts canonical `T3CODE_CLERK_*` variables.

For a free Apple Personal Team, use a unique reverse-DNS bundle ID you control:

```bash
EXPO_NO_DOTENV=1 EXPO_OFFLINE=1 \
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.voice \
vp exec expo prebuild --platform ios
```

This removes widgets/share extensions, push, native Apple sign-in, App Groups, and
associated-domain entitlements. Dictation and direct pairing remain available.
Keychain access follows the resolved bundle ID. Open the generated Xcode workspace
and select your own Personal Team. Alternatively, supply your own optional
`T3CODE_IOS_APPLE_TEAM_ID`; no account or team is embedded in source. Login, Apple
agreements, provisioning, and device pairing are user-controlled steps, not automatic.

For development after installing a matching native client, use `vp run dev:client`
with `APP_VARIANT=development` identity. A self-contained Release build embeds JS/assets
and does not need Metro. Rebuild the native client after native or config changes.
Do not reuse upstream cached clients or upstream App Store builds for this fork.

## What an artifact proves

- A simulator `.app` needs no device provisioning and runs only in the simulator.
- An unsigned arm64 device `.app` or IPA is **not installable** until separately
  signed and provisioned. Packaging an IPA does not solve signing.
- Installing on a real iPhone without paid membership requires the user's Xcode
  Personal Team, a supported paired device, and Apple's free-provisioning limits.
  Verify the generated profile's expiry; re-signing/reinstalling is recurring work.
- TestFlight, App Store, and paid-team distribution are not configured or promised.

Configuration tests and simulator builds do not prove physical microphone, speaker,
Bluetooth, interruption, or voice-engine behavior. Inspect the generated plist,
entitlements, embedded assets, and bundle ID before device installation.

## Focused checks

```bash
vp test run --project unit app.config.test.ts src/lib/appLinking.test.ts
vp run typecheck
```

EAS build profiles are optional templates with local versioning, no OTA channels,
and no submission profiles. They require the user's own Expo project and credentials;
the local Xcode path above does not require an Expo account.
