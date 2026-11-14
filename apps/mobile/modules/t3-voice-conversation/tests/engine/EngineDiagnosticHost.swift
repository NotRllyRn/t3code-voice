// Concatenated after production source: private access stays out of the product build.
#if !T3_VOICE_ENGINE_DIAGNOSTIC || !targetEnvironment(simulator)
#error("Compile this host only with T3_VOICE_ENGINE_DIAGNOSTIC for Simulator")
#endif
import Synchronization
import Darwin

private struct ProbeBlock {
  var host: UInt64 = 0
  var sample: Int64 = 0
  var frames = 0
  var valid = false
  var peak: Float = 0
  var energy: Double = 0
  var tone440: Double = 0
  var tone880: Double = 0
  var tone1320: Double = 0
}

// Both the paired player clock and request must be within one measured quantum + IO buffer
// of the latest tone interval. More than 200 ms of freshness uncertainty is not resolvable.
private func toneFreshness(signal: Double, begin: Double, end: Double, playerTime: Double?,
                           requestTime: Double, quantum: Double, ioDuration: Double,
                           rate: Double, continuous: Bool) -> String {
  guard signal.isFinite, signal > 0.015 else { return "FAIL" }
  guard continuous, let playerTime,
        [begin, end, playerTime, requestTime, quantum, ioDuration, rate].allSatisfy({ $0.isFinite }),
        rate > 0, quantum > 0, ioDuration >= 0, end > begin else { return "UNVERIFIED" }
  let tolerance = quantum + ioDuration + 2 / rate
  guard tolerance <= 0.2, end - begin <= quantum + 2 / rate else { return "UNVERIFIED" }
  return [playerTime, requestTime].allSatisfy { $0 >= begin - tolerance && $0 <= end + tolerance }
    ? "PASS" : "UNVERIFIED"
}

private final class OutputProbe {
  static let capacity = 2048
  let rate: Double
  let channels: UInt32
  let blocks: UnsafeMutablePointer<ProbeBlock>
  let published = Atomic<Int>(0)
  let overflow = Atomic<Bool>(false)
  private var written = 0 // Single audio callback producer; never read by control thread.
  private let c440: Double
  private let s440: Double
  private let c880: Double
  private let s880: Double
  private let c1320: Double
  private let s1320: Double

  init(format: AVAudioFormat) throws {
    guard format.commonFormat == .pcmFormatFloat32, !format.isInterleaved,
          format.sampleRate > 2640, format.channelCount > 0 else {
      throw voiceError("Unmeasurable mixer format")
    }
    blocks = .allocate(capacity: Self.capacity)
    rate = format.sampleRate
    channels = format.channelCount
    c440 = cos(2 * .pi * 440 / rate); s440 = sin(2 * .pi * 440 / rate)
    c880 = cos(2 * .pi * 880 / rate); s880 = sin(2 * .pi * 880 / rate)
    c1320 = cos(2 * .pi * 1320 / rate); s1320 = sin(2 * .pi * 1320 / rate)
    blocks.initialize(repeating: ProbeBlock(), count: Self.capacity)
  }

  deinit {
    blocks.deinitialize(count: Self.capacity)
    blocks.deallocate()
  }

  // No locks, dispatch, collections, JSON or session/engine calls on the audio thread.
  func record(_ buffer: AVAudioPCMBuffer, _ time: AVAudioTime) {
    guard written < Self.capacity else { overflow.store(true, ordering: .releasing); return }
    var b = ProbeBlock()
    b.host = time.hostTime; b.sample = time.sampleTime; b.frames = Int(buffer.frameLength)
    b.valid = time.isHostTimeValid && time.isSampleTimeValid && time.sampleRate == rate
      && buffer.format.sampleRate == rate && buffer.format.channelCount == channels
      && b.frames > 0 && b.frames <= 16384
    if b.valid, let samples = buffer.floatChannelData {
      var x1 = 1.0, y1 = 0.0, x2 = 1.0, y2 = 0.0, x3 = 1.0, y3 = 0.0
      var a1 = 0.0, z1 = 0.0, a2 = 0.0, z2 = 0.0, a3 = 0.0, z3 = 0.0
      for i in 0..<b.frames {
        // Mono product source is mixed to all channels; measure channel zero, peak all channels.
        let v = Double(samples[0][i])
        if !v.isFinite { b.valid = false }
        b.energy += v * v
        for channel in 0..<Int(channels) { b.peak = max(b.peak, abs(samples[channel][i])) }
        a1 += v * x1; z1 += v * y1; a2 += v * x2; z2 += v * y2; a3 += v * x3; z3 += v * y3
        let n1 = x1 * c440 - y1 * s440; y1 = y1 * c440 + x1 * s440; x1 = n1
        let n2 = x2 * c880 - y2 * s880; y2 = y2 * c880 + x2 * s880; x2 = n2
        let n3 = x3 * c1320 - y3 * s1320; y3 = y3 * c1320 + x3 * s1320; x3 = n3
      }
      let n = Double(b.frames)
      b.energy /= n
      b.tone440 = 2 * sqrt(a1 * a1 + z1 * z1) / n
      b.tone880 = 2 * sqrt(a2 * a2 + z2 * z2) / n
      b.tone1320 = 2 * sqrt(a3 * a3 + z3 * z3) / n
    } else { b.valid = false }
    blocks[written] = b
    written += 1
    published.store(written, ordering: .releasing)
  }
}

private struct EngineSnapshot {
  let json: [String: Any]
  let ledger: VoicePlaybackLedger
  let rendered: Int64?
  let latency: Int64
  let playerHost: UInt64?
  let playerFrame: Int64?
  let clean: Bool
}

private extension VoiceAudioSession {
  func diagnosticSnapshot() -> EngineSnapshot {
    lock.lock()
    defer { lock.unlock() }
    let hasConverter = conversion.sync { converter != nil }
    inputLock.lock()
    defer { inputLock.unlock() }
    let frame = rendered()
    let delay = latency
    let node = player.lastRenderTime
    let clock = node.flatMap { player.playerTime(forNodeTime: $0) }
    let playerHost = node?.isHostTimeValid == true ? node?.hostTime : nil
    let playerFrame = clock?.isSampleTimeValid == true && clock?.sampleRate == 24000 ? clock?.sampleTime : nil
    let audio = AVAudioSession.sharedInstance()
    let clean = closed && !engine.isRunning && !player.isPlaying && !outputAllowed
      && ledger.segments.isEmpty && observers.isEmpty && !tapped && !hasConverter
      && inputFormat == nil && !accepting && reservedFrames == 0 && outstanding.isEmpty
    return EngineSnapshot(json: [
      "closed": closed, "engineRunning": engine.isRunning, "playerPlaying": player.isPlaying,
      "outputAllowed": outputAllowed, "outputEpoch": outputEpoch, "tapped": tapped,
      "converter": hasConverter, "inputFormat": inputFormat != nil, "accepting": accepting,
      "reservedFrames": reservedFrames, "outstanding": outstanding.count, "observers": observers.count,
      "rendered": frame.map { $0 as Any } ?? NSNull(), "latencyFrames": delay,
      "playerHost": playerHost.map { $0 as Any } ?? NSNull(),
      "playerFrame": playerFrame.map { $0 as Any } ?? NSNull(),
      "playerRate": clock?.sampleRate ?? 0,
      "outputSampleRate": engine.outputNode.outputFormat(forBus: 0).sampleRate,
      "ledgerEnd": ledger.end, "segments": ledger.segments.map {
        ["item": $0.item, "index": $0.index, "start": $0.start, "end": $0.end, "offset": $0.offset] as [String: Any]
      },
      "sampleRate": audio.sampleRate, "ioBufferDuration": audio.ioBufferDuration,
      "outputLatency": audio.outputLatency, "presentationLatency": engine.outputNode.presentationLatency,
      "category": audio.category.rawValue, "mode": audio.mode.rawValue,
      "route": audio.currentRoute.outputs.map { ["type": $0.portType.rawValue, "channels": $0.channels?.count ?? 0] }
    ], ledger: ledger, rendered: frame, latency: delay, playerHost: playerHost, playerFrame: playerFrame, clean: clean)
  }

  func installOutputProbe() throws -> OutputProbe {
    let format = engine.mainMixerNode.outputFormat(forBus: 0)
    let probe = try OutputProbe(format: format)
    engine.mainMixerNode.installTap(onBus: 0, bufferSize: 256, format: format) { buffer, time in
      probe.record(buffer, time)
    }
    return probe
  }

  func removeOutputProbe() { engine.mainMixerNode.removeTap(onBus: 0) }

  func diagnosticInterrupt(quantum: Double, validateTone: (EngineSnapshot, UInt64) throws -> Void) throws
    -> (EngineSnapshot, EngineSnapshot, [String: Any], UInt64, UInt64, Int64) {
    lock.lock()
    defer { lock.unlock() }
    let before = diagnosticSnapshot()
    guard let host = before.playerHost, let playerFrame = before.playerFrame, before.rendered != nil else {
      throw voiceError("Missing actual player clock bracket")
    }
    let request = mach_absolute_time()
    try validateTone(before, request)
    let position = silence()
    let returned = mach_absolute_time()
    let after = diagnosticSnapshot()
    guard let position else { throw voiceError("Missing silence position") }
    // stop/reset destroys the player timeline. Bound its last possible frame using the paired
    // real player host/sample clock, call-return host time, and one measured mixer quantum.
    let elapsed = max(0, AVAudioTime.seconds(forHostTime: returned) - AVAudioTime.seconds(forHostTime: host))
    let upper = max(before.rendered!, playerFrame + Int64(ceil((elapsed + quantum) * 24000)))
    return (before, after, position, request, returned, upper)
  }
}

private final class EngineScenario: NSObject {
  private var owner: VoiceAudioSession?
  private weak var released: VoiceAudioSession?
  private var probe: OutputProbe?
  private var probes: [OutputProbe] = []
  private var cursor = 0
  private var stage = "first"
  private var terminal = false
  private var display: CADisplayLink?
  private var watchdog: Timer?
  private var gates: [String: String] = [:]
  private var evidence: [String: Any] = [:]
  private var snapshots: [[String: Any]] = []
  private var captureEvents = 0
  private var failures: [[String: Any]] = []
  private var previousFrame: Int64?
  private var advances = 0
  private var interruptBefore: UInt64 = 0
  private var interruptAfter: UInt64 = 0
  private var latencySeconds = 0.0
  private var lastOldEnd = 0.0
  private var silentStart: Double?
  private var silentEnd = 0.0
  private var maxQuantum = 0.0
  private var timingResolvable = true
  private var previousBlock: ProbeBlock?

  func start() {
    watchdog = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in
      self?.finish(error: "Watchdog: missing audio/render milestone")
    }
    do {
      try checkToneFreshnessRegression()
      try open(id: "first")
      guard let owner else { throw voiceError("Missing owner") }
      owner.allow(epoch: 1)
      let pcm = tone(440, frames: 24000)
      try owner.enqueue(epoch: 1, item: "first", index: 7, pcm: pcm)
      try owner.enqueue(epoch: 1, item: "first", index: 7, pcm: pcm)
      let s = owner.diagnosticSnapshot()
      try require(s.ledger.segments.count == 2 && s.ledger.segments[1].offset == 24000
        && s.ledger.segments[1].start == s.ledger.segments[0].end, "contiguous_chunks")
      display = CADisplayLink(target: self, selector: #selector(drain))
      display?.add(to: .main, forMode: .common)
    } catch { finish(error: error.localizedDescription) }
  }

  private func open(id: String) throws {
    owner = VoiceAudioSession(id: id) { [weak self] event, body in
      // Production notification scenarios below are posted on main, as are all control calls.
      DispatchQueue.main.async {
        guard let self else { return }
        if event == "capture" { self.captureEvents += 1 }
        if event == "failure" { self.failures.append(body) }
        if event == "failure", self.stage != "background-delivery" {
          self.finish(error: "Unexpected native failure: \(body)")
        }
        if self.stage == "background-delivery" { self.checkBackgroundDelivery() }
      }
    }
    try owner!.open()
    let p = try owner!.installOutputProbe()
    probe = p; probes.append(p); cursor = 0; previousFrame = nil; advances = 0; previousBlock = nil
    let s = owner!.diagnosticSnapshot()
    snapshots.append(s.json)
    try require(s.json["engineRunning"] as? Bool == true && s.json["tapped"] as? Bool == false
      && s.json["converter"] as? Bool == false && s.json["inputFormat"] as? Bool == false
      && s.json["accepting"] as? Bool == false && s.json["reservedFrames"] as? Int == 0
      && s.json["outstanding"] as? Int == 0, "output_only_\(id)")
  }

  private func tone(_ frequency: Double, frames: Int) -> String {
    var bytes = Data(count: frames * 2)
    bytes.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
      for i in 0..<frames {
        let value = UInt16(bitPattern: Int16(sin(2 * .pi * frequency * Double(i) / 24000) * 1638))
        raw[i * 2] = UInt8(value & 255); raw[i * 2 + 1] = UInt8(value >> 8)
      }
    }
    return bytes.base64EncodedString()
  }

  private func require(_ condition: Bool, _ gate: String) throws {
    gates[gate] = condition ? "PASS" : "FAIL"
    if !condition { throw voiceError(gate) }
  }

  private func seconds(_ host: UInt64) -> Double { AVAudioTime.seconds(forHostTime: host) }

  private func checkToneFreshnessRegression() throws {
    func status(_ signal: Double = 0.04, begin: Double = 9.98, end: Double = 9.99,
                player: Double? = 9.99, request: Double = 10, quantum: Double = 0.01,
                continuous: Bool = true) -> String {
      toneFreshness(signal: signal, begin: begin, end: end, playerTime: player,
        requestTime: request, quantum: quantum, ioDuration: 0.01, rate: 24000, continuous: continuous)
    }
    try require(status() == "PASS"
      && status(begin: 9.49, end: 9.50) == "UNVERIFIED" // Historical tone, live player clock.
      && status(0) == "FAIL" // Earlier positive block cannot replace the latest silent block.
      && status(player: 9.5) == "UNVERIFIED"
      && status(player: nil) == "UNVERIFIED"
      && status(request: 10.5) == "UNVERIFIED"
      && status(begin: 10.5, end: 10.51) == "UNVERIFIED"
      && status(quantum: 0.25) == "UNVERIFIED"
      && status(continuous: false) == "UNVERIFIED", "tone_freshness_regression")
  }

  private func requireFreshTone(_ snapshot: EngineSnapshot, request: UInt64, frequency: Int, gate: String) throws {
    guard let block = previousBlock, let probe else {
      gates[gate] = "FAIL"
      throw voiceError("Missing actual tone interval: \(gate)")
    }
    let begin = seconds(block.host), end = begin + Double(block.frames) / probe.rate
    let signal = frequency == 440 ? block.tone440 : block.tone880
    let ioDuration = snapshot.json["ioBufferDuration"] as? Double ?? .nan
    let status = toneFreshness(signal: signal, begin: begin, end: end,
      playerTime: snapshot.playerHost.map { seconds($0) }, requestTime: seconds(request),
      quantum: maxQuantum, ioDuration: ioDuration, rate: probe.rate, continuous: timingResolvable && block.valid)
    let tolerance = maxQuantum + ioDuration + 2 / probe.rate
    gates[gate] = status
    evidence[gate] = ["frequencyHz": frequency, "amplitude": signal, "threshold": 0.015,
      "blockHost": block.host, "sampleStart": block.sample, "sampleEnd": block.sample + Int64(block.frames),
      "beginSeconds": begin, "endSeconds": end, "rate": probe.rate,
      "playerHost": snapshot.playerHost.map { $0 as Any } ?? NSNull(), "requestHost": request,
      "maxQuantumSeconds": maxQuantum, "ioBufferDuration": ioDuration.isFinite ? ioDuration as Any : NSNull(),
      "freshnessToleranceSeconds": tolerance.isFinite ? tolerance as Any : NSNull(),
      "continuousTime": timingResolvable, "status": status]
    guard status == "PASS" else { throw voiceError("\(gate): \(status)") }
  }

  @objc private func drain() {
    guard !terminal, let probe, let owner else { return }
    do {
      try require(!probe.overflow.load(ordering: .acquiring), "bounded_probe")
      let count = probe.published.load(ordering: .acquiring)
      guard count > cursor else { return } // Display cadence alone never advances a scenario.
      while cursor < count {
        let b = probe.blocks[cursor]; cursor += 1
        try require(b.valid, "valid_probe_time_and_format")
        let duration = Double(b.frames) / probe.rate
        maxQuantum = max(maxQuantum, duration)
        let begin = seconds(b.host), end = begin + duration
        if let prior = previousBlock {
          let sampleGap = b.sample - prior.sample - Int64(prior.frames)
          let hostGap = begin - (seconds(prior.host) + Double(prior.frames) / probe.rate)
          if sampleGap != 0 || abs(hostGap) > 2 / probe.rate {
            timingResolvable = false
            if stage == "flush" { silentStart = nil }
          }
        }
        previousBlock = b
        if (stage == "first" || stage == "flush"), b.tone440 > 0.005 { lastOldEnd = max(lastOldEnd, end) }
        if stage == "flush" {
          if b.tone440 > 0.005 { lastOldEnd = max(lastOldEnd, end) }
          // Exclude blocks straddling the synchronous stop/reset call.
          if begin >= seconds(interruptAfter) {
            try require(b.tone1320 < 0.005, "rejected_marker_absent")
            if b.peak < 0.0001 {
              if silentStart == nil { silentStart = begin }
              silentEnd = end
            } else { silentStart = nil }
          }
        }
        if stage == "second", begin >= seconds(interruptAfter) {
          try require(b.tone440 < 0.015 && b.tone1320 < 0.015, "no_old_marker_second_turn")
        }
      }
      let s = owner.diagnosticSnapshot()
      try require(s.json["accepting"] as? Bool == false && s.json["reservedFrames"] as? Int == 0
        && s.json["outstanding"] as? Int == 0 && captureEvents == 0, "no_capture")
      if let frame = s.rendered {
        if let previousFrame, frame > previousFrame { advances += 1 }
        previousFrame = frame
      }
      switch stage {
      case "first":
        if advances >= 2, let frame = s.rendered, frame - s.latency > 28000, frame < 44000 {
          try interrupt(owner, first: true)
          try require(true, "actual_first_tone_and_advancing_player")
        }
      case "flush":
        if let silentStart, silentEnd - silentStart >= 0.2 {
          let bound = max(0, max(lastOldEnd, silentStart) - seconds(interruptBefore)) + latencySeconds + maxQuantum
          evidence["flush"] = ["requestHost": interruptBefore, "returnHost": interruptAfter,
            "lastOldToneEndSeconds": lastOldEnd, "silentStartSeconds": silentStart,
            "silentEndSeconds": silentEnd, "maxQuantumSeconds": maxQuantum,
            "downstreamBoundSeconds": latencySeconds, "conservativeBoundMs": bound * 1000,
            "continuousTime": timingResolvable]
          // Large quantum, gaps, or an oversized model bound cannot be promoted to PASS.
          gates["flush_engine_bound_200ms"] = timingResolvable && bound <= 0.2 ? "PASS" : "UNVERIFIED"
          try require(true, "continuing_silent_output_200ms")
          stage = "second"; previousFrame = nil; advances = 0
          owner.allow(epoch: 3)
          try owner.enqueue(epoch: 1, item: "rejected", index: 0, pcm: tone(1320, frames: 6000))
          try owner.enqueue(epoch: 3, item: "second", index: 9, pcm: tone(880, frames: 36000))
          let next = owner.diagnosticSnapshot()
          try require(next.ledger.segments.count == 1 && next.ledger.segments[0].item == "second", "new_epoch_only")
        }
      case "second":
        if advances >= 2, let frame = s.rendered, frame - s.latency > 6000, frame < 30000 {
          try interrupt(owner, first: false)
          try require(true, "actual_second_tone_and_advancing_player")
          owner.allow(epoch: 5)
          try owner.enqueue(epoch: 5, item: "stop", index: 0, pcm: tone(880, frames: 24000))
          stage = "stop"; previousFrame = nil; advances = 0
        }
      case "stop":
        if advances >= 1, let frame = s.rendered, frame > s.latency + 2400 {
          try requireFreshTone(s, request: mach_absolute_time(), frequency: 880, gate: "fresh_stop_tone")
          try require(s.json["playerPlaying"] as? Bool == true, "stop_during_actual_playback")
          owner.close(deactivate: false)
          try require(owner.diagnosticSnapshot().clean, "native_stop_resources")
          snapshots.append(owner.diagnosticSnapshot().json)
          owner.allow(epoch: 99)
          try owner.enqueue(epoch: 99, item: "closed", index: 0, pcm: tone(440, frames: 1000))
          owner.close(deactivate: false)
          try require(owner.diagnosticSnapshot().clean, "closed_cannot_restart_and_idempotent")
          NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
          removeAndRelease()
          stage = "release"
          DispatchQueue.main.async { [weak self] in self?.afterRelease() }
        }
      case "background":
        if advances >= 1, let frame = s.rendered, frame > s.latency + 2400 {
          try requireFreshTone(s, request: mach_absolute_time(), frequency: 440, gate: "fresh_background_tone")
          stage = "background-delivery"
          NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
          try require(owner.diagnosticSnapshot().clean, "notification_deactivate_true_resources")
          snapshots.append(owner.diagnosticSnapshot().json)
        }
      default: break
      }
    } catch { finish(error: error.localizedDescription) }
  }

  private func interrupt(_ owner: VoiceAudioSession, first: Bool) throws {
    let (before, after, position, request, returned, upperFrame) = try owner.diagnosticInterrupt(quantum: maxQuantum) { before, request in
      try self.requireFreshTone(before, request: request, frequency: first ? 440 : 880,
        gate: first ? "fresh_first_interrupt_tone" : "fresh_second_interrupt_tone")
    }
    interruptBefore = request; interruptAfter = returned
    guard let lowerFrame = before.rendered else { throw voiceError("Missing production rendered position") }
    let low = before.ledger.position(rendered: lowerFrame, latencyFrames: max(before.latency, after.latency))
    let high = before.ledger.position(rendered: upperFrame, latencyFrames: min(before.latency, after.latency))
    let ms = (position["ms"] as? NSNumber)?.int64Value ?? -1
    let lo = (low?["ms"] as? NSNumber)?.int64Value ?? -1
    let hi = (high?["ms"] as? NSNumber)?.int64Value ?? -1
    try require(position["itemId"] as? String == (first ? "first" : "second")
      && position["contentIndex"] as? Int == (first ? 7 : 9)
      && ms >= lo - 1 && ms <= hi + 1 && ms > (first ? 1000 : 0)
      && ms < (first ? 2000 : 1500), first ? "cumulative_chunk_position" : "second_item_position")
    try require(seconds(interruptAfter) - seconds(interruptBefore) <= 0.2, first ? "silence_call_200ms" : "second_silence_call_200ms")
    try require(after.ledger.segments.isEmpty && after.json["playerPlaying"] as? Bool == false
      && after.json["outputAllowed"] as? Bool == false, first ? "silence_reset" : "second_silence_reset")
    evidence[first ? "firstInterrupt" : "secondInterrupt"] = ["before": before.json, "after": after.json,
      "position": position, "lowerMs": lo, "upperMs": hi, "upperFrame": upperFrame,
      "upperFrameModel": "paired real player host/sample clock through return plus measured mixer quantum",
      "toneEvidenceGate": first ? "fresh_first_interrupt_tone" : "fresh_second_interrupt_tone",
      "requestHost": interruptBefore, "returnHost": interruptAfter]
    if first {
      latencySeconds = Double(max(before.latency, after.latency)) / 24000
      try owner.enqueue(epoch: 1, item: "late", index: 0, pcm: tone(1320, frames: 6000))
      try owner.enqueue(epoch: 2, item: "without-allow", index: 0, pcm: tone(1320, frames: 6000))
      let rejected = owner.diagnosticSnapshot()
      try require(rejected.ledger.segments.isEmpty && rejected.json["playerPlaying"] as? Bool == false, "late_epoch_and_without_allow_rejected")
      stage = "flush"
    }
  }

  private func removeAndRelease() {
    if probe != nil { owner?.removeOutputProbe(); probe = nil }
    released = owner
    owner = nil
  }

  private func afterRelease() {
    guard !terminal else { return }
    do {
      try require(released == nil, "weak_release")
      try require(failures.isEmpty, "post_close_notification_ignored")
      try open(id: "background")
      stage = "background"
      owner!.allow(epoch: 1)
      try owner!.enqueue(epoch: 1, item: "background", index: 0, pcm: tone(440, frames: 24000))
    } catch { finish(error: error.localizedDescription) }
  }

  private func checkBackgroundDelivery() {
    guard !terminal else { return }
    do {
      try require(failures.count == 1 && failures[0]["id"] as? String == "background"
        && failures[0]["message"] as? String == "Audio changed or app left foreground. Start voice again.", "native_background_failure_callback")
      removeAndRelease()
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        do {
          try self.require(self.released == nil, "background_weak_release")
          self.finish(error: nil)
        } catch { self.finish(error: error.localizedDescription) }
      }
    } catch { finish(error: error.localizedDescription) }
  }

  private func finish(error: String?) {
    guard !terminal else { return }
    terminal = true; display?.invalidate(); display = nil; watchdog?.invalidate(); watchdog = nil
    if probe != nil { owner?.removeOutputProbe(); probe = nil }
    owner?.close(deactivate: true); owner = nil
    if let error { gates["terminal"] = "FAIL"; evidence["error"] = error }
    else { gates["terminal"] = "PASS" }
    gates["no_capture_events"] = captureEvents == 0 ? "PASS" : "FAIL"
    let required = ["tone_freshness_regression", "fresh_first_interrupt_tone", "fresh_second_interrupt_tone",
      "fresh_stop_tone", "fresh_background_tone",
      "contiguous_chunks", "output_only_first", "output_only_background", "bounded_probe",
      "valid_probe_time_and_format", "no_capture", "actual_first_tone_and_advancing_player", "cumulative_chunk_position",
      "silence_call_200ms", "silence_reset", "late_epoch_and_without_allow_rejected", "rejected_marker_absent",
      "flush_engine_bound_200ms", "continuing_silent_output_200ms", "new_epoch_only", "no_old_marker_second_turn",
      "actual_second_tone_and_advancing_player", "second_item_position", "second_silence_call_200ms", "second_silence_reset",
      "stop_during_actual_playback", "native_stop_resources", "closed_cannot_restart_and_idempotent", "weak_release",
      "post_close_notification_ignored", "notification_deactivate_true_resources", "native_background_failure_callback",
      "background_weak_release", "no_capture_events", "terminal"]
    for key in required where gates[key] == nil { gates[key] = "UNVERIFIED" }
    let passed = required.allSatisfy { gates[$0] == "PASS" }
    let records: [[String: Any]] = probes.enumerated().map { index, p in
      let count = p.published.load(ordering: .acquiring)
      return ["session": index, "rate": p.rate, "channels": p.channels,
        "overflow": p.overflow.load(ordering: .acquiring), "blocks": (0..<count).map { i in
          let b = p.blocks[i]
          return ["host": b.host, "sample": b.sample, "frames": b.frames, "valid": b.valid,
            "peak": b.peak, "energy": b.energy, "tone440": b.tone440, "tone880": b.tone880, "tone1320": b.tone1320] as [String: Any]
        }]
    }
    let result: [String: Any] = ["kind": "actual-engine-output-only-simulator", "passed": passed,
      "gates": gates, "requiredGates": required, "evidence": evidence, "snapshots": snapshots,
      "probes": records, "captureEvents": captureEvents, "failures": failures,
      "thresholds": ["toneAmplitude": 0.015, "oldToneTailAmplitude": 0.005, "silentPeak": 0.0001,
        "hostContinuityToleranceFrames": 2, "positionRoundingToleranceMs": 1],
      "notProven": ["physical speaker", "duplex/input", "Expo JS bridge", "JS flush latency", "audio-session isActive", "OS background transition"]]
    do {
      let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("result.json")
      try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]).write(to: url, options: .atomic)
      print("actual-engine-output-only-simulator: \(passed ? "PASS" : "NOT PASS")")
      fflush(stdout)
      exit(passed ? 0 : 1)
    } catch { print("Result persistence failed: \(error)"); fflush(stdout); exit(2) }
  }
}

@main
private final class EngineDiagnosticApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  private var scenario: EngineScenario?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = UIViewController()
    window.makeKeyAndVisible()
    self.window = window
    return true
  }
  func applicationDidBecomeActive(_ application: UIApplication) {
    guard scenario == nil else { return }
    let run = EngineScenario(); scenario = run; run.start()
  }
}
