import Foundation

struct VoicePlaybackLedger {
  struct Segment {
    let item: String
    let index: Int
    let start: Int64
    let end: Int64
    let offset: Int64
  }

  static let rate: Double = 24_000
  // 3 s scheduled + (128 KiB bridge + 128 KiB receive) * 3/4 / 2 = 170,304 < 192,000 samples.
  static let limit: Int64 = 72_000
  private(set) var segments: [Segment] = []
  private(set) var end: Int64 = 0
  private var offsets: [String: Int64] = [:]

  mutating func append(item: String, index: Int, frames: Int64, start: Int64, audible: Int64) throws {
    segments.removeAll { $0.end < audible }
    guard frames > 0, frames <= Self.limit, start + frames - audible <= Self.limit,
          segments.count < 512 else { throw voiceError("Voice output queue overflow") }
    let key = "\(item):\(index)"
    guard offsets[key] != nil || offsets.count < 512 else { throw voiceError("Voice item limit") }
    let offset = offsets[key] ?? 0
    segments.append(Segment(item: item, index: index, start: start, end: start + frames, offset: offset))
    offsets[key] = offset + frames
    end = start + frames
  }

  func position(rendered: Int64?, latencyFrames: Int64) -> [String: Any]? {
    guard let first = segments.first else { return nil }
    guard let rendered else {
      return ["itemId": first.item, "contentIndex": first.index, "ms": 0]
    }
    let audible = max(0, rendered - max(0, latencyFrames))
    let segment = segments.last(where: { $0.start <= audible }) ?? first
    let frames = max(0, min(audible, segment.end) - segment.start)
    return ["itemId": segment.item, "contentIndex": segment.index, "ms": (segment.offset + frames) * 1000 / 24_000]
  }
}

func voiceError(_ message: String) -> NSError {
  NSError(domain: "T3VoiceConversation", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
