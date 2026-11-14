import Foundation

// Receipts survive socket close: an Expo event retains its payload until JS disposes of it.
struct VoiceReceiveWindow {
  struct Receipt {
    let id: Int
    let bytes: Int
  }

  static let limit = 128 * 1024
  static let messageLimit = 128 * 1024
  private(set) var bytes = 0
  private(set) var receipts: [Int: Receipt] = [:]
  private var sequence = 0

  mutating func admit(id: Int, bytes: Int) throws -> Int {
    guard bytes >= 0, bytes <= Self.messageLimit, bytes <= Self.limit - self.bytes,
          receipts.count < 512, sequence < Int.max else {
      throw NSError(domain: "T3WebSocket", code: 2, userInfo: [NSLocalizedDescriptionKey: "Voice receive queue overflow"])
    }
    sequence += 1
    receipts[sequence] = Receipt(id: id, bytes: bytes)
    self.bytes += bytes
    return sequence
  }

  mutating func acknowledge(id: Int, sequence: Int) {
    guard let receipt = receipts[sequence], receipt.id == id else { return }
    bytes -= receipt.bytes
    receipts.removeValue(forKey: sequence)
  }
}
