import Foundation

public struct AnyDefinition {
  public let name: String
  public let value: Any
  public init(_ name: String, _ value: Any) { self.name = name; self.value = value }
}
public typealias ModuleDefinition = [AnyDefinition]
@resultBuilder public enum ModuleDefinitionBuilder {
  public static func buildBlock(_ values: AnyDefinition...) -> ModuleDefinition { values }
}
public protocol AnyModule: AnyObject {
  @ModuleDefinitionBuilder func definition() -> ModuleDefinition
}
open class BaseModule {
  public var events: [(String, [String: Any])] = []
  public var beforeEvent: ((String) -> Void)?
  public init() {}
  public func sendEvent(_ name: String, _ body: [String: Any]) {
    beforeEvent?(name)
    events.append((name, body))
  }
}
public typealias Module = AnyModule & BaseModule
public func Name(_ name: String) -> AnyDefinition { AnyDefinition("name", name) }
public func Events(_ names: String...) -> AnyDefinition { AnyDefinition("events", names) }
public func Function<T>(_ name: String, _ body: T) -> AnyDefinition { AnyDefinition(name, body) }
public func OnCreate(_ body: @escaping () -> Void) -> AnyDefinition { AnyDefinition("create", body) }
public func OnDestroy(_ body: @escaping () -> Void) -> AnyDefinition { AnyDefinition("destroy", body) }
public struct Uint8Array {
  public let rawPointer: UnsafeRawPointer
  public let byteLength: Int
}
