import Foundation

// Deterministic transport; the test compiles and drives the real module callbacks, not a copied lifecycle.
class URLSessionTask {
  enum State { case suspended, running, canceling }
  var state: State = .suspended
  func cancel() { state = .canceling }
}
final class URLSessionWebSocketTask: URLSessionTask {
  enum CloseCode: Int { case invalid = 0, normalClosure = 1000, goingAway = 1001 }
  enum Message { case string(String), data(Data) }
  var maximumMessageSize = 0
  var received: ((Result<Message, Error>) -> Void)?
  var sent: ((Error?) -> Void)?
  func resume() { state = .running }
  func cancel(with: CloseCode, reason: Data?) { cancel() }
  func receive(completionHandler: @escaping (Result<Message, Error>) -> Void) { received = completionHandler }
  func send(_ message: Message, completionHandler: @escaping (Error?) -> Void) { sent = completionHandler }
}
final class URLSessionConfiguration {
  static var `default`: URLSessionConfiguration { URLSessionConfiguration() }
  var protocolClasses: [AnyClass] = []
}
protocol URLSessionWebSocketDelegate: AnyObject {}
final class URLSession {
  init(configuration: URLSessionConfiguration, delegate: URLSessionWebSocketDelegate, delegateQueue: OperationQueue) {}
  func webSocketTask(with: URL, protocols: [String] = []) -> URLSessionWebSocketTask { URLSessionWebSocketTask() }
  func invalidateAndCancel() {}
}
