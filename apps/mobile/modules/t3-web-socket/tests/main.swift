import Foundation

// swiftc ios/VoiceReceiveWindow.swift ../t3-voice-conversation/ios/VoicePlaybackLedger.swift tests/main.swift -o /tmp/t3-voice-receive && /tmp/t3-voice-receive
func rejects(_ body: () throws -> Void) {
  do {
    try body()
    assertionFailure("Expected terminal receive overflow")
  } catch {}
}

var window = VoiceReceiveWindow()
let id = 7
let chunk = 6_400 + 256 // 100 ms PCM16 base64 plus conservative JSON overhead.
var delivered: [Int] = []
// Stall JS entirely: receipts cannot be released just because Expo sendEvent returned.
for _ in 0..<(VoiceReceiveWindow.limit / chunk) {
  delivered.append(try window.admit(id: id, bytes: chunk))
}
assert(window.bytes == delivered.count * chunk)
rejects { _ = try window.admit(id: id, bytes: chunk) }
assert(window.bytes <= VoiceReceiveWindow.limit)
assert(window.receipts.count == delivered.count)

// Even a full scheduled ledger plus the bridge and the currently decoded (unadmitted)
// URLSession frame fit the original eight seconds, without relying on JSON overhead.
var ledger = VoicePlaybackLedger()
try ledger.append(item: "reply", index: 0, frames: VoicePlaybackLedger.limit, start: 0, audible: 0)
let ingressSamples = (VoiceReceiveWindow.limit + VoiceReceiveWindow.messageLimit) * 3 / 4 / 2
assert(VoicePlaybackLedger.limit + Int64(ingressSamples) <= 192_000)

// Wrong, duplicated, future, and old-connection acknowledgments cannot release credit.
let first = delivered[0]
window.acknowledge(id: id + 1, sequence: first)
window.acknowledge(id: id, sequence: delivered.last! + 1)
assert(window.bytes == delivered.count * chunk)
window.acknowledge(id: id, sequence: first)
let afterAck = window.bytes
window.acknowledge(id: id, sequence: first)
assert(window.bytes == afterAck)
let replacement = try window.admit(id: id, bytes: chunk)
window.acknowledge(id: id, sequence: first)
assert(window.receipts[replacement] != nil)

// Closing must not erase receipts: the stale bridge payload still exists. The module
// rejects another voice connection until these are disposed, then never reuses tokens.
for sequence in delivered { window.acknowledge(id: id, sequence: sequence) }
window.acknowledge(id: id, sequence: replacement)
assert(window.bytes == 0 && window.receipts.isEmpty)
let successor = try window.admit(id: id + 1, bytes: VoiceReceiveWindow.messageLimit)
window.acknowledge(id: id, sequence: successor)
window.acknowledge(id: id, sequence: replacement)
assert(window.bytes == VoiceReceiveWindow.messageLimit)
rejects { _ = try window.admit(id: id + 1, bytes: 1) }
window.acknowledge(id: id + 1, sequence: successor)
rejects { _ = try window.admit(id: id + 1, bytes: VoiceReceiveWindow.messageLimit + 1) }
assert(window.bytes == 0)

// Zero-byte or tiny control events also have a hard object-count bound.
for _ in 0..<512 { _ = try window.admit(id: id + 1, bytes: 0) }
rejects { _ = try window.admit(id: id + 1, bytes: 0) }
assert(window.receipts.count == 512)
print("Voice receive accounting passed (170304 / 192000 samples maximum)")
