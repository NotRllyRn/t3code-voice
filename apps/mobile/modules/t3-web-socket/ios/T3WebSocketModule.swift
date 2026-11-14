import ExpoModulesCore
import Foundation
import UIKit

private final class Connection {
  let id: Int
  var task: URLSessionWebSocketTask?
  var finished = false
  let audioStopLock = NSRecursiveLock()
  var audioStopped = false
  var requestedCloseCode: Int?
  var failure: String?
  var pendingBytes = 0
  let voice: Bool

  init(id: Int, voice: Bool) {
    self.id = id
    self.voice = voice
  }
}

/// A WebSocket client that offers permessage-deflate. React Native's SocketRocket never does,
/// so a large snapshot reached an iPhone uncompressed. URLSession offers the extension on every
/// handshake with no public switch, which is what we want here.
public final class T3WebSocketModule: Module {
  private var connections: [Int: Connection] = [:]
  private var nextId = 1
  private var voiceReceive = VoiceReceiveWindow()
  private let lock = NSLock()
  private var session: URLSession?
  private var backgroundObserver: NSObjectProtocol?
  private let delegateQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return queue
  }()

  public func definition() -> ModuleDefinition {
    Name("T3WebSocket")
    Events("open", "message", "close", "error")

    Function("connect") { (url: URL, protocols: [String]) throws -> Int in
      try self.connect(url: url, protocols: protocols, voice: false)
    }

    Function("connectVoice") { (url: URL) throws -> Int in
      try self.connect(url: url, protocols: [], voice: true)
    }
    Function("ackVoiceMessage") { (id: Int, sequence: Int) in
      self.withLock { self.voiceReceive.acknowledge(id: id, sequence: sequence) }
    }
    Function("pendingBytes") { (id: Int) -> Int in
      self.withLock { self.connections[id]?.pendingBytes ?? 0 }
    }
    Function("sendText") { (id: Int, text: String) throws in
      try self.send(id: id, message: .string(text), bytes: text.utf8.count)
    }
    Function("sendBinary") { (id: Int, bytes: Uint8Array) throws in
      let data = Data(bytes: bytes.rawPointer, count: bytes.byteLength)
      try self.send(id: id, message: .data(data), bytes: data.count)
    }

    Function("close") { (id: Int, code: Int, reason: String) in
      guard let connection = self.connection(id) else { return }
      // URLSession can only send the codes it names; anything else goes out as a normal closure.
      let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code).flatMap { $0 == .invalid ? nil : $0 } ?? .normalClosure
      let task = self.withLock { () -> URLSessionWebSocketTask? in
        connection.requestedCloseCode = closeCode.rawValue
        return connection.task
      }
      self.stopVoiceAudio(connection)
      task?.cancel(with: closeCode, reason: reason.isEmpty ? nil : reason.data(using: .utf8))
    }

    OnCreate {
      self.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.willResignActiveNotification, object: nil, queue: nil
      ) { [weak self] _ in
        guard let self else { return }
        let voices = self.withLock { self.connections.values.filter { $0.voice } }
        for connection in voices {
          self.stopVoiceAudio(connection)
          connection.task?.cancel(with: .goingAway, reason: nil)
        }
      }
    }
    OnDestroy {
      if let observer = self.backgroundObserver { NotificationCenter.default.removeObserver(observer) }
      let voices = self.withLock { self.connections.values.filter { $0.voice } }
      for connection in voices { self.stopVoiceAudio(connection) }
      self.session?.invalidateAndCancel()
    }
  }

  private func connect(url: URL, protocols: [String], voice: Bool) throws -> Int {
    let connection = try withLock { () throws -> Connection in
      guard !voice || (voiceReceive.receipts.isEmpty && !connections.values.contains { $0.voice }) else {
        throw NSError(domain: "T3WebSocket", code: 2, userInfo: [NSLocalizedDescriptionKey: "Previous voice connection is still draining"])
      }
      let connection = Connection(id: nextId, voice: voice)
      nextId += 1
      connections[connection.id] = connection
      return connection
    }
    let session = self.session ?? makeSession()
    self.session = session
    let task = protocols.isEmpty ? session.webSocketTask(with: url) : session.webSocketTask(with: url, protocols: protocols)
    // Voice opts into a small receive bound. RPC snapshots keep their existing 128 MiB limit.
    task.maximumMessageSize = voice ? VoiceReceiveWindow.messageLimit : 128 * 1024 * 1024
    withLock { connection.task = task }
    if voice {
      NotificationCenter.default.post(name: Notification.Name("T3VoiceConnectionOpened"), object: nil, userInfo: ["id": connection.id])
    }
    task.resume()
    receive(on: connection, task: task)
    return connection.id
  }

  private func send(id: Int, message: URLSessionWebSocketTask.Message, bytes: Int) throws {
    let reserved = withLock { () -> (Connection, URLSessionWebSocketTask, Bool)? in
      guard let connection = connections[id], !connection.finished, connection.requestedCloseCode == nil,
            connection.failure == nil, let task = connection.task else { return nil }
      let stalled = connection.voice && bytes > 64 * 1024 - connection.pendingBytes
      if !stalled { connection.pendingBytes += bytes }
      return (connection, task, stalled)
    }
    guard let (connection, task, stalled) = reserved else { return }
    if stalled {
      let error = NSError(domain: "T3WebSocket", code: 1, userInfo: [NSLocalizedDescriptionKey: "Voice connection is stalled"])
      fail(connection, task: task, error: error)
      throw error
    }
    task.send(message) { [weak self] error in
      guard let self else { return }
      self.withLock { connection.pendingBytes = max(0, connection.pendingBytes - bytes) }
      if let error { self.fail(connection, task: task, error: error) }
    }
  }

  private func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.default
    // Dev clients register URLProtocol classes that intercept the upgrade and drop the socket.
    configuration.protocolClasses = []
    return URLSession(configuration: configuration, delegate: SessionDelegate(module: self), delegateQueue: delegateQueue)
  }

  private func connection(_ id: Int) -> Connection? {
    withLock { connections[id] }
  }

  private func connection(for task: URLSessionTask) -> Connection? {
    withLock { connections.values.first { $0.task === task } }
  }

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  private func receive(on connection: Connection, task: URLSessionWebSocketTask) {
    guard withLock({ !connection.finished && connection.failure == nil && connection.requestedCloseCode == nil }) else { return }
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(.string(let text)):
        self.deliver(on: connection, task: task, body: ["text": text], bytes: text.utf8.count)
      case .success(.data(let data)):
        self.deliver(on: connection, task: task, body: ["data": data], bytes: data.count)
      case .success:
        self.receive(on: connection, task: task)
      case .failure(let error):
        self.fail(connection, task: task, error: error)
      }
    }
  }

  private func deliver(on connection: Connection, task: URLSessionWebSocketTask, body: [String: Any], bytes: Int) {
    do {
      let event = try withLock { () throws -> [String: Any]? in
        guard !connection.finished, connection.failure == nil, connection.requestedCloseCode == nil else { return nil }
        var event = body
        event["id"] = connection.id
        if connection.voice { event["sequence"] = try voiceReceive.admit(id: connection.id, bytes: bytes) }
        return event
      }
      guard let event else { return }
      sendEvent("message", event)
      receive(on: connection, task: task)
    } catch {
      fail(connection, task: task, error: error)
    }
  }

  /// Every ending is reported once, from the delegate. A receive or send failure on a task that is
  /// still running (an oversized message, for one) gets no delegate callback until it is cancelled.
  private func fail(_ connection: Connection, task: URLSessionWebSocketTask, error: Error) {
    let live = withLock { () -> Bool in
      guard !connection.finished, connection.failure == nil, connection.requestedCloseCode == nil else { return false }
      connection.failure = error.localizedDescription
      return true
    }
    guard live else { return }
    stopVoiceAudio(connection)
    if task.state == .running { task.cancel() }
  }

  fileprivate func didOpen(task: URLSessionWebSocketTask) {
    guard let connection = connection(for: task) else { return }
    sendEvent("open", ["id": connection.id])
  }

  fileprivate func didClose(task: URLSessionWebSocketTask, code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    guard let connection = connection(for: task) else { return }
    finish(connection, code: code.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "", clean: true)
  }

  fileprivate func didComplete(task: URLSessionTask, error: Error?) {
    guard let connection = connection(for: task) else { return }
    let (requested, failure) = withLock { (connection.requestedCloseCode, connection.failure) }
    stopVoiceAudio(connection)
    if requested == nil, let message = failure ?? error?.localizedDescription {
      sendEvent("error", ["id": connection.id, "message": message])
    }
    // A task that ends without a close frame is an abnormal closure, as in browsers; one we
    // cancelled ourselves reports the code we asked for.
    finish(connection, code: requested ?? (error == nil && failure == nil ? 1005 : 1006), reason: "", clean: requested != nil)
  }

  private func stopVoiceAudio(_ connection: Connection) {
    guard connection.voice else { return }
    connection.audioStopLock.lock()
    defer { connection.audioStopLock.unlock() }
    guard !connection.audioStopped else { return }
    connection.audioStopped = true
    // Serialize native shutdown too, not just its flag. Never call observers under the socket lock.
    NotificationCenter.default.post(name: Notification.Name("T3VoiceConnectionFailed"), object: nil, userInfo: ["id": connection.id])
  }

  private func finish(_ connection: Connection, code: Int, reason: String, clean: Bool) {
    stopVoiceAudio(connection)
    let first = withLock { () -> Bool in
      if connection.finished { return false }
      connection.finished = true
      connections.removeValue(forKey: connection.id)
      return true
    }
    guard first else { return }
    sendEvent("close", ["id": connection.id, "code": code, "reason": reason, "wasClean": clean])
  }
}

private final class SessionDelegate: NSObject, URLSessionWebSocketDelegate {
  weak var module: T3WebSocketModule?

  init(module: T3WebSocketModule) {
    self.module = module
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    module?.didOpen(task: webSocketTask)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    module?.didClose(task: webSocketTask, code: closeCode, reason: reason)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    module?.didComplete(task: task, error: error)
  }
}
