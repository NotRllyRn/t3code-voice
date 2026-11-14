import Foundation

// Standalone native accounting check. Run on macOS:
// swiftc ios/VoicePlaybackLedger.swift tests/main.swift -o /tmp/t3-voice-ledger && /tmp/t3-voice-ledger
func milliseconds(_ value: [String: Any]?) -> Int64 {
  value?["ms"] as? Int64 ?? -1
}

var ledger = VoicePlaybackLedger()
assert(ledger.position(rendered: 0, latencyFrames: 0) == nil)
try ledger.append(item: "a", index: 0, frames: 24_000, start: 0, audible: 0)
assert(milliseconds(ledger.position(rendered: nil, latencyFrames: 0)) == 0)
assert(milliseconds(ledger.position(rendered: 12_000, latencyFrames: 2400)) == 400)
assert(milliseconds(ledger.position(rendered: 100_000, latencyFrames: 2400)) == 1000)
assert(milliseconds(ledger.position(rendered: 100, latencyFrames: 2400)) == 0)
try ledger.append(item: "a", index: 0, frames: 24_000, start: 24_000, audible: 24_001)
// Pruning consumed chunks must not reset an item's cumulative position.
assert(milliseconds(ledger.position(rendered: 36_000, latencyFrames: 2400)) == 1400)
try ledger.append(item: "b", index: 1, frames: 24_000, start: 48_000, audible: 24_001)
assert(ledger.position(rendered: 60_000, latencyFrames: 2400)?["itemId"] as? String == "b")
assert(milliseconds(ledger.position(rendered: 60_000, latencyFrames: 2400)) == 400)
var bounded = VoicePlaybackLedger()
try bounded.append(item: "full", index: 0, frames: 192_000, start: 0, audible: 0)
do {
  try bounded.append(item: "overflow", index: 0, frames: 1, start: 192_000, audible: 0)
  assertionFailure("Unrendered output exceeded eight seconds")
} catch {}
ledger = VoicePlaybackLedger()
assert(ledger.position(rendered: nil, latencyFrames: 0) == nil)
print("Voice playback accounting passed")
