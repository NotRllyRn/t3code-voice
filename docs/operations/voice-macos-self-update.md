# Voice macOS self-update

Opt-in source support; **not yet validated with paired full-product builds**. Default/ad-hoc builds remain manual-only. No paid Apple account is required for persistent self-signed update identity, but this does **not** provide notarization or first-install Gatekeeper trust.

## Private publisher setup

Provision one persistent code-signing certificate and matching PEM private key separately, after approving this approach. Do not reuse disposable prototype keys or generate a new identity for every release. Back up the identity privately. Keep certificate/key files 0600, signer 0700, in owner-only 0700 directories outside the checkout, staging and artifact directories. Never upload them. Losing/rotating the certificate requires another explicit manual bootstrap.

The optional signer is the official `indygreg/apple-platform-rs` release `apple-codesign/0.29.0`, artifact `apple-codesign-0.29.0-aarch64-apple-darwin.tar.gz` (SHA-256 `d1a532150adaf90048260d76359261aa716abafc45c53c5dc18845029184334a`). Fetch from the official GitHub release, verify the archive checksum, then verify the extracted executable with system `codesign --verify --strict` **before execution**. The build additionally requires its Apple-trusted Developer ID team `MK22MZP987`, exact CDHash `b19a77eacc2cc2c524b3af822ecaa29c33f4d418`, and version `apple-codesign 0.29.0`. Do not install globally. The signer's Apple identity does not notarize our output.

On a macOS arm64 builder, set all four build-time variables, then invoke the existing desktop artifact builder with `--platform mac --arch arm64 --target dmg --signed` and an approved `--version`:

```sh
export T3VOICE_MAC_UPDATE_FEED='https://github.com/NotRllyRn/t3code-voice/releases/download/voice-stable/'
export T3VOICE_MAC_CERT='/private/publisher/certificate.pem'
export T3VOICE_MAC_KEY='/private/publisher/key.pem'
export T3VOICE_RCODESIGN='/private/tools/rcodesign'
```

These are absolute private-file paths, not PEM contents or passwords. The private key must be usable noninteractively; protect it with filesystem permissions and private builder access. No keychain import or production-key generation is automated. Ordinary builds without these settings retain the existing signing/manual-update paths. Partial settings or unsigned opt-ins fail, rather than publishing a misleading auto-update build.

The optional driver recursively signs nested code and the outer bundle with the same identity, hardened runtime and the product's JIT/native-library/audio/camera entitlement set, then checks native strict/deep/all-architecture integrity and publisher/bundle identity. This entitlement/signing combination still needs a real product launch and update test; the earlier minimal fixture did not prove it. No Gatekeeper, quarantine, or native update verification bypass is added.

## Candidate test feed (not production)

A separate, build-time-only `T3VOICE_MAC_UPDATE_TRACK=voice-candidate` opt-in requires the exact `T3VOICE_MAC_UPDATE_FEED=https://github.com/NotRllyRn/t3code-voice/releases/download/voice-candidate/`. The omitted track defaults to `voice-stable` with its existing exact URL. Cross-mixed tracks/URLs and every other URL fail. No runtime environment override is supported; both tracks use the same publisher and native signature checks. Candidate apps are named **T3 Code Voice Candidate — Not Production**.

The candidate release must be a public prerelease, never latest, titled **Test feed — do not install**. Check that the tag is unused before building/publishing; never overwrite existing candidate assets. Publish only reviewed B ZIP/feed assets from committed source on a feature branch. Disposable test certificates are only for owned candidate profiles, not production trust or a new user release. Existing manual apps remain manual; testing needs an explicit candidate A bootstrap. Retain published assets until the release manager decides otherwise.

## Feed and versions

Use the shared Voice release contract: `0.1.10-voice.1` → `0.1.10-voice.2`, or `0.1.11-voice.1`. Do not relabel upstream nightly versions as Voice stable. Only strictly newer Voice versions on the `latest` desktop channel are offered; prerelease SemVer here describes the fork version, not a nightly track.

The builder explicitly publishes generic-provider metadata on `latest` (macOS filename `latest-mac.yml`) even though the version contains `-voice.N`. Publish the generated ZIP, its blockmap, and matching YAML under the selected track's exact release asset path (`voice-stable` by default; isolated `voice-candidate` only by explicit build opt-in). Do not hand-edit checksums or rename artifacts behind YAML. Stage assets first and replace metadata last. Release workflows, version bumps, tag/asset permissions and publication remain release-manager work; this change does not publish anything.

Opt-in builds keep package/feed/runtime versions semantic, but encode `A.B.C-voice.R` as native `CFBundleShortVersionString = A.B.(1000*C+R)`. Components must be canonical nonnegative ASCII integers; revisions are 1–999 and all three native components must be ≤2,147,483,647 (a conservative product limit, not an Apple limit). Overflow, other prereleases and build metadata fail the build. The radix must not change for this track. For example `.10-voice.999` maps to `.10999`, then `.11-voice.1` maps to `.11001`. Native About/Finder may display the numeric value.

Every opt-in bundle bakes boolean `ElectronSquirrelPreventDowngrades = true` before signing. The signer checks the final plist against the packaged semantic version; runtime also requires the exact mapping and flag before enabling updates. Stock Squirrel rejects a correctly signed candidate older than the installed native version. **It allows equal versions and versions higher than the offer** from the accepted publisher: this is not exact-offer binding or strictly-newer cryptographic enforcement. A compromised signing key can still relabel old code. Recheck the pinned Squirrel behavior when upgrading Electron.

A baked package marker contains only the feed, track and public certificate fingerprint. Runtime accepts it only in a packaged macOS app whose installed signature passes native verification for that certificate and Voice bundle ID, with the native version mapping and rollback flag present. Environment/mock/managed feed overrides cannot select another source for this mode. Feed checksums are transport integrity, not publisher authorization: Electron's native Squirrel/ShipIt verification remains the authority for downloaded targets. An attacker-controlled feed cannot authorize a wrong-certificate or modified application.

## Bootstrap and acceptance

Existing ad-hoc installations, or signed clients missing the numeric version/flag, require **one trusted manual installation** of the approved persistent-certificate build, using normal OS trust/approval procedures. A new target cannot retroactively protect an unguarded installed client. This code neither installs trust nor clears quarantine; self-signed output is not notarized and may be rejected by normal OS policy. Do not promise a frictionless first install.

Before publishing, test paired full products on the pinned Electron **44.10.1** / electron-updater **6.8.9**: A launches with the intended entitlements; A downloads, installs and relaunches newer same-certificate/same-bundle B; individually valid wrong-certificate and resource-tampered B ZIPs with matching feed checksums fail without replacing A. Exercise offline/missing metadata and manual download recovery. Inspect generated `latest-mac.yml` paths/checksums and ensure no private files entered artifacts/logs. Also test installed `.2` with the guard: same-certificate `.1` disguised as offered `.3` must fail with A unchanged; genuine `.3` must install and retain semantic runtime/updater versions. Repeat the old-target case only in a disposable flag-false control to prove flag causality. A legacy suffixed native version must fail. Observe and report stock acceptance for equal `.2` and actual `.4` offered as `.3`, rather than claiming those gaps are closed. The paired full-product checks remain pending. A separate minimal-fixture run proved native older-target rejection, its flag-false vulnerability control, genuine update/relaunch, wrong-certificate rejection and sealed-resource rejection; it did not prove product packaging, entitlements or UI integration.

Missing/incompatible baked configuration or invalid installed identity keeps the manual-only UI. If a configured feed is missing/offline, use the fork's Releases page for manual recovery; there is no upstream download fallback. Certificate rotation is an explicit manual bootstrap, not an automatic trust transition.
