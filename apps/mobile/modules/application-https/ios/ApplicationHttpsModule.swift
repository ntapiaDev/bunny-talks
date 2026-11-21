import BunnyHttpsNative
import ExpoModulesCore
import Foundation

public final class ApplicationHttpsModule: Module {
  private let transport = CurlHttpsTransport()

  public func definition() -> ModuleDefinition {
    Name("ApplicationHttps")
    OnDestroy { transport.close() }

    #if BUNNY_HTTPS_QUALIFICATION
    Function("qualificationProfile") {
      bunny_https_runtime_profile().map { String(cString: $0) } ?? "unavailable"
    }
    #endif

    Function("reserve") { (timeoutMs: Int) in
      self.transport.reserve(timeoutMs: timeoutMs)
    }
    Function("cancel") { (id: String) in
      self.transport.cancel(id: id)
    }
    AsyncFunction("execute") {
      (id: String, url: String, method: String, headers: [String: String], body: String?,
       limit: Int, promise: Promise) in
      self.transport.execute(id: id, url: url, method: method, headers: headers, body: body,
                             limit: limit, promise: promise)
    }
  }
}
