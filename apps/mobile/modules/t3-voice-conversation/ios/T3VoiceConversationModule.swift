import AVFoundation
import ExpoModulesCore
import UIKit

public final class T3VoiceConversationModule: Module {
  private let stateLock = NSRecursiveLock()
  private var current: VoiceAudioSession?

  public func definition() -> ModuleDefinition {
    Name("T3VoiceConversation")
    Events("capture", "failure")

    Function("open") { (id: String) throws in
      self.stateLock.lock()
      defer { self.stateLock.unlock() }
      self.current?.close(deactivate: false)
      self.current = nil
      let session = VoiceAudioSession(id: id) { [weak self] event, body in
        self?.sendEvent(event, body)
      }
      do {
        try session.open()
        self.current = session
      } catch {
        session.close(deactivate: true)
        throw error
      }
    }
    Function("capture") { (id: String, epoch: Int) throws in
      try self.owned(id) { try $0.capture(epoch: epoch) }
    }
    Function("finishCapture") { (id: String, epoch: Int) throws -> Int in
      try self.owned(id) { try $0.finishCapture(epoch: epoch) }
    }
    Function("ackCapture") { (id: String, sequence: Int) in
      try? self.owned(id) { $0.ackCapture(sequence) }
    }
    Function("mute") { (id: String) in
      try? self.owned(id) { $0.mute() }
    }
    Function("allow") { (id: String, epoch: Int) in
      try? self.owned(id) { $0.allow(epoch: epoch) }
    }
    Function("enqueue") { (id: String, epoch: Int, item: String, index: Int, pcm: String) throws in
      try self.owned(id) { try $0.enqueue(epoch: epoch, item: item, index: index, pcm: pcm) }
    }
    Function("silence") { (id: String) -> [String: Any]? in
      (try? self.owned(id) { $0.silence() }) ?? nil
    }
    Function("close") { (id: String) in
      self.stateLock.lock()
      defer { self.stateLock.unlock() }
      guard self.current?.id == id else { return }
      self.current?.close(deactivate: false)
      self.current = nil
    }
    OnDestroy {
      self.stateLock.lock()
      defer { self.stateLock.unlock() }
      self.current?.close(deactivate: true)
      self.current = nil
    }
  }

  private func owned<T>(_ id: String, _ body: (VoiceAudioSession) throws -> T) throws -> T {
    stateLock.lock()
    defer { stateLock.unlock() }
    guard let current, current.id == id else { throw voiceError("Voice owner expired") }
    return try body(current)
  }
}

private final class VoiceAudioSession {
  let id: String
  private let event: (String, [String: Any]) -> Void
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let lock = NSRecursiveLock()
  private let inputLock = NSLock()
  private let conversion = DispatchQueue(label: "t3.voice.capture")
  private let pcm = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
  private let playback = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
  private var converter: AVAudioConverter?
  private var inputFormat: AVAudioFormat?
  private var tapped = false
  private var closed = false
  private var connectionId: Int?
  private var observers: [NSObjectProtocol] = []
  private var captureEpoch = 0
  private var accepting = false
  private var reservedFrames = 0
  private var sequence = 0
  private var outstanding: [Int: Int] = [:]
  private var outputEpoch = 0
  private var outputAllowed = false
  private var ledger = VoicePlaybackLedger()

  init(id: String, event: @escaping (String, [String: Any]) -> Void) {
    self.id = id
    self.event = event
  }

  func open() throws {
    lock.lock()
    defer { lock.unlock() }
    guard UIApplication.shared.applicationState == .active else { throw voiceError("Voice requires foreground") }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
    try session.setPreferredSampleRate(24_000)
    try session.setPreferredIOBufferDuration(0.01)
    try session.setActive(true)
    engine.attach(player)
    try engine.inputNode.setVoiceProcessingEnabled(true)
    let hardware = engine.inputNode.outputFormat(forBus: 0)
    guard hardware.sampleRate > 0, hardware.channelCount > 0,
          let converter = AVAudioConverter(from: hardware, to: pcm) else {
      throw voiceError("Unsupported microphone format")
    }
    inputFormat = hardware
    self.converter = converter
    engine.connect(player, to: engine.mainMixerNode, format: playback)
    engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: hardware) { [weak self] buffer, _ in
      self?.receive(buffer)
    }
    tapped = true
    engine.prepare()
    try engine.start()
    let center = NotificationCenter.default
    for name in [UIApplication.didEnterBackgroundNotification, UIApplication.willResignActiveNotification,
                 AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification,
                 AVAudioSession.mediaServicesWereResetNotification, Notification.Name.AVAudioEngineConfigurationChange] {
      observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
        self?.lostAudio()
      })
    }
    for name in ["T3VoiceConnectionOpened", "T3VoiceConnectionFailed"] {
      observers.append(center.addObserver(forName: Notification.Name(name), object: nil, queue: nil) { [weak self] event in
        self?.connectionChanged(event)
      })
    }
    guard UIApplication.shared.applicationState == .active, engine.isRunning, !closed else {
      throw voiceError("Audio changed during activation")
    }
  }

  private func connectionChanged(_ event: Notification) {
    lock.lock()
    defer { lock.unlock() }
    guard !closed, let id = event.userInfo?["id"] as? Int else { return }
    if event.name == Notification.Name("T3VoiceConnectionOpened") {
      if connectionId == nil { connectionId = id }
    } else if connectionId == id {
      lostAudio()
    }
  }

  private func lostAudio() {
    close(deactivate: true)
    event("failure", ["id": id, "message": "Audio changed or app left foreground. Start voice again."])
  }

  func capture(epoch: Int) throws {
    lock.lock()
    defer { lock.unlock() }
    inputLock.lock()
    accepting = false
    inputLock.unlock()
    try conversion.sync {
      guard !closed, let format = inputFormat, let next = AVAudioConverter(from: format, to: pcm) else {
        throw voiceError("Voice capture is unavailable")
      }
      converter = next
    }
    inputLock.lock()
    captureEpoch = epoch
    accepting = true
    inputLock.unlock()
  }

  private func receive(_ buffer: AVAudioPCMBuffer) {
    inputLock.lock()
    defer { inputLock.unlock() }
    guard accepting else { return }
    let epoch = captureEpoch
    let reservation = Int(ceil(Double(buffer.frameLength) * 24_000 / buffer.format.sampleRate)) + 32
    guard reservedFrames + outstanding.values.reduce(0, +) + reservation <= Int(VoicePlaybackLedger.limit) else {
      accepting = false
      DispatchQueue.global().async { [weak self] in self?.lostAudio() }
      return
    }
    guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
      accepting = false
      DispatchQueue.global().async { [weak self] in self?.lostAudio() }
      return
    }
    copy.frameLength = buffer.frameLength
    let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
    let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    for i in 0..<source.count {
      guard let from = source[i].mData, let to = target[i].mData else {
        accepting = false
        DispatchQueue.global().async { [weak self] in self?.lostAudio() }
        return
      }
      memcpy(to, from, Int(source[i].mDataByteSize))
    }
    reservedFrames += reservation
    // Enqueue under the gate lock: finish cannot overtake an accepted tap buffer.
    conversion.async { [weak self] in
      guard let self else { return }
      do { try self.convert(copy, epoch: epoch, end: false) }
      catch { DispatchQueue.global().async { self.lostAudio() } }
      self.inputLock.lock()
      self.reservedFrames -= reservation
      self.inputLock.unlock()
    }
  }

  private func convert(_ input: AVAudioPCMBuffer?, epoch: Int, end: Bool) throws {
    inputLock.lock()
    let cancelled = closed || epoch != captureEpoch
    inputLock.unlock()
    if cancelled { return }
    guard let converter else { throw voiceError("Missing PCM converter") }
    var supplied = false
    while true {
      guard let output = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: 2400) else {
        throw voiceError("PCM allocation failed")
      }
      var error: NSError?
      let status = converter.convert(to: output, error: &error) { _, state in
        if let input, !supplied { supplied = true; state.pointee = .haveData; return input }
        state.pointee = end ? .endOfStream : .noDataNow
        return nil
      }
      if let error { throw error }
      if status == .error { throw voiceError("PCM conversion failed") }
      if output.frameLength > 0 {
        let count = Int(output.frameLength)
        inputLock.lock()
        if closed || epoch != captureEpoch { inputLock.unlock(); return }
        guard reservedFrames + outstanding.values.reduce(0, +) + count <= Int(VoicePlaybackLedger.limit), outstanding.count < 512 else {
          inputLock.unlock()
          throw voiceError("Voice capture bridge overflow")
        }
        sequence += 1
        let seq = sequence
        outstanding[seq] = count
        inputLock.unlock()
        guard let data = output.int16ChannelData?[0] else { throw voiceError("Invalid converted PCM") }
        event("capture", ["id": id, "epoch": epoch, "sequence": seq, "samples": count,
                          "audio": Data(bytes: data, count: count * 2).base64EncodedString()])
      }
      if status == .inputRanDry || status == .endOfStream { return }
      if output.frameLength == 0 { throw voiceError("PCM converter made no progress") }
    }
  }

  func finishCapture(epoch: Int) throws -> Int {
    inputLock.lock()
    accepting = false
    let matches = captureEpoch == epoch
    inputLock.unlock()
    return try conversion.sync {
      if matches { try convert(nil, epoch: epoch, end: true) }
      inputLock.lock()
      defer { inputLock.unlock() }
      guard !closed else { throw voiceError("Voice closed during capture drain") }
      return sequence
    }
  }

  func ackCapture(_ seq: Int) {
    inputLock.lock()
    outstanding.removeValue(forKey: seq)
    inputLock.unlock()
  }

  func mute() {
    inputLock.lock()
    accepting = false
    captureEpoch += 1
    inputLock.unlock()
  }

  func allow(epoch: Int) {
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { return }
    outputEpoch = epoch
    outputAllowed = true
  }

  private func rendered() -> Int64? {
    guard let time = player.lastRenderTime, let position = player.playerTime(forNodeTime: time),
          position.isSampleTimeValid, position.sampleRate == 24_000 else { return nil }
    return max(0, position.sampleTime)
  }

  private var latency: Int64 {
    let session = AVAudioSession.sharedInstance()
    let downstream = max(session.outputLatency, engine.outputNode.presentationLatency)
    return Int64(ceil((downstream + session.ioBufferDuration * 2) * 24_000))
  }

  func enqueue(epoch: Int, item: String, index: Int, pcm encoded: String) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !closed, outputAllowed, epoch == outputEpoch else { return }
    guard encoded.utf8.count <= 512_000, let bytes = Data(base64Encoded: encoded),
          !bytes.isEmpty, bytes.count % 2 == 0, bytes.count <= Int(VoicePlaybackLedger.limit) * 2,
          !item.isEmpty, item.utf8.count <= 256, index >= 0 else { throw voiceError("Invalid voice PCM") }
    let frames = bytes.count / 2
    guard let buffer = AVAudioPCMBuffer(pcmFormat: playback, frameCapacity: AVAudioFrameCount(frames)),
          let output = buffer.floatChannelData?[0] else { throw voiceError("PCM allocation failed") }
    bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      for i in 0..<frames {
        let value = Int16(bitPattern: UInt16(raw[i * 2]) | UInt16(raw[i * 2 + 1]) << 8)
        output[i] = Float(value) / 32768
      }
    }
    buffer.frameLength = AVAudioFrameCount(frames)
    let position = rendered() ?? 0
    let start = max(ledger.end, position == 0 ? 0 : position + latency)
    try ledger.append(item: item, index: index, frames: Int64(frames), start: start, audible: max(0, position - latency))
    player.scheduleBuffer(buffer, at: AVAudioTime(sampleTime: start, atRate: 24_000), options: [])
    if !player.isPlaying { player.play() }
  }

  func silence() -> [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    outputAllowed = false
    outputEpoch += 1
    let position = ledger.position(rendered: rendered(), latencyFrames: latency)
    player.stop()
    player.reset()
    ledger = VoicePlaybackLedger()
    return position
  }

  func close(deactivate: Bool) {
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { return }
    inputLock.lock()
    closed = true
    accepting = false
    captureEpoch += 1
    inputLock.unlock()
    _ = silence()
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
    engine.stop()
    conversion.sync { converter = nil }
    inputLock.lock()
    reservedFrames = 0
    outstanding.removeAll()
    inputLock.unlock()
    if deactivate { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
  }
}
