import ExpoModulesCore
import Foundation
import UIKit

// Concatenated with the module so the fixture can drive its real private callbacks without public test APIs.
extension T3WebSocketModule {
  static func testTerminalCallbacks() throws {
    let failure = NSError(domain: "test", code: 1)
    let endings = ["explicit", "receive", "send", "remote-close", "complete-error", "complete-clean", "timeout", "receive-overflow", "send-overflow", "background", "destroy"]
    for voice in [true, false] {
      for ending in endings {
        if !voice && ["receive-overflow", "send-overflow", "background"].contains(ending) { continue }
        let module = T3WebSocketModule()
        let definitions = module.definition()
        let create = definitions.first { $0.name == "create" }!.value as! () -> Void
        let destroy = definitions.first { $0.name == "destroy" }!.value as! () -> Void
        create()
        let id = try module.connect(url: URL(string: "wss://example.invalid")!, protocols: [], voice: voice)
        let connection = module.connections[id]!
        let task = connection.task!
        var stopped: [Int] = []
        let observer = NotificationCenter.default.addObserver(
          forName: Notification.Name("T3VoiceConnectionFailed"), object: nil, queue: nil
        ) { event in stopped.append(event.userInfo!["id"] as! Int) }
        defer { NotificationCenter.default.removeObserver(observer) }
        // JS is never consumed. Native shutdown must precede even emission of its terminal events.
        module.beforeEvent = { name in
          if voice && (name == "close" || name == "error") {
            precondition(stopped == [id], "\(ending): terminal Expo event overtook native stop")
          }
        }
        switch ending {
        case "explicit":
          let close = definitions.first { $0.name == "close" }!.value as! (Int, Int, String) -> Void
          close(id, 1000, "")
        case "receive": task.received?(.failure(failure))
        case "send":
          try module.send(id: id, message: .string("input"), bytes: 5)
          task.sent?(failure)
        case "remote-close": module.didClose(task: task, code: .normalClosure, reason: nil)
        case "complete-clean": module.didComplete(task: task, error: nil)
        case "complete-error": module.didComplete(task: task, error: failure)
        case "timeout": task.received?(.failure(URLError(.timedOut)))
        case "receive-overflow": task.received?(.success(.string(String(repeating: "x", count: VoiceReceiveWindow.messageLimit + 1))))
        case "send-overflow":
          do {
            try module.send(id: id, message: .string("too much"), bytes: 64 * 1024 + 1)
            preconditionFailure("Expected send admission failure")
          } catch {}
        case "background": NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        case "destroy": destroy()
        default: preconditionFailure("Unknown test")
        }
        precondition(stopped == (voice ? [id] : []), "\(ending): native shutdown was not synchronous or touched RPC")
        // A delegate-first ending followed by receive/send failure used to lose native shutdown entirely.
        module.didComplete(task: task, error: failure)
        task.received?(.failure(failure))
        task.sent?(failure)
        module.didClose(task: task, code: .goingAway, reason: nil)
        precondition(stopped == (voice ? [id] : []), "\(ending): duplicate native shutdown")
        precondition(module.events.filter { $0.0 == "close" }.count == 1)
        if ending != "destroy" { destroy() }
      }
    }

    let module = T3WebSocketModule()
    var owner: Int?
    var stops = 0
    let opened = NotificationCenter.default.addObserver(forName: Notification.Name("T3VoiceConnectionOpened"), object: nil, queue: nil) {
      owner = $0.userInfo!["id"] as? Int
    }
    let ended = NotificationCenter.default.addObserver(forName: Notification.Name("T3VoiceConnectionFailed"), object: nil, queue: nil) {
      if owner == $0.userInfo!["id"] as? Int { stops += 1 }
    }
    defer {
      NotificationCenter.default.removeObserver(opened)
      NotificationCenter.default.removeObserver(ended)
    }
    let oldId = try module.connect(url: URL(string: "wss://example.invalid")!, protocols: [], voice: true)
    let old = module.connections[oldId]!
    module.didClose(task: old.task!, code: .normalClosure, reason: nil)
    let newId = try module.connect(url: URL(string: "wss://example.invalid")!, protocols: [], voice: true)
    precondition(owner == newId && stops == 1)
    module.didComplete(task: old.task!, error: failure)
    module.fail(old, task: old.task!, error: failure)
    precondition(owner == newId && stops == 1, "Late old callback stopped successor")
    module.didComplete(task: module.connections[newId]!.task!, error: failure)
    precondition(stops == 2)
    print("Actual socket callbacks: synchronous once-only voice shutdown, stale/RPC isolation passed")
  }
}

try T3WebSocketModule.testTerminalCallbacks()
