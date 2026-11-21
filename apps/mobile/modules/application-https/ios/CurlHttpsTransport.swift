import BunnyHttpsNative
import ExpoModulesCore
import Foundation

final class CurlHttpsTransport: @unchecked Sendable {
  private final class Operation: @unchecked Sendable {
    let handle: OpaquePointer

    init?() {
      guard let handle = bunny_https_create() else { return nil }
      self.handle = handle
    }

    deinit { bunny_https_destroy(handle) }
  }

  private final class Slot {
    let deadline: DispatchTime
    let timer: DispatchSourceTimer
    var operation: Operation?
    var promise: Promise?

    init(deadline: DispatchTime, timer: DispatchSourceTimer) {
      self.deadline = deadline
      self.timer = timer
    }

    var expired: Bool { DispatchTime.now() >= deadline }
  }

  // Only the control queue can touch slots or settle promises.
  private let control = DispatchQueue(label: "fr.bunnytalks.applicationhttps.control")
  private let workers = DispatchQueue(label: "fr.bunnytalks.applicationhttps.curl", attributes: .concurrent)
  private var slots: [String: Slot] = [:]
  private var closed = false

  func reserve(timeoutMs: Int) -> String? {
    control.sync {
      guard !closed, slots.count < 2, (1...120_000).contains(timeoutMs) else { return nil }
      let id = UUID().uuidString
      let deadline = DispatchTime.now() + .milliseconds(timeoutMs)
      let timer = DispatchSource.makeTimerSource(queue: control)
      slots[id] = Slot(deadline: deadline, timer: timer)
      timer.schedule(deadline: deadline)
      timer.setEventHandler { [weak self] in self?.stop(id, kind: "timeout") }
      timer.resume()
      return id
    }
  }

  func cancel(id: String) {
    control.sync { stop(id, kind: "network") }
  }

  func close() {
    control.sync {
      closed = true
      for id in Array(slots.keys) { stop(id, kind: "network") }
      slots.removeAll()
    }
  }

  func execute(id: String, url: String, method: String, headers: [String: String],
               body: String?, limit: Int, promise: Promise) {
    control.sync {
      guard let slot = slots[id], slot.operation == nil else {
        promise.resolve(Self.failure("network"))
        return
      }
      slot.promise = promise
      guard !slot.expired else { stop(id, kind: "timeout"); return }
      guard (1...1_048_576).contains(limit),
            let fields = Self.requestFields(url: url, method: method, headers: headers, body: body),
            let operation = Operation(),
            fields.allSatisfy({ bunny_https_add_header(operation.handle, $0) })
      else { stop(id, kind: "network"); return }

      slot.operation = operation
      let deadline = slot.deadline.uptimeNanoseconds
      workers.async { [weak self] in
        let payload = body.map { Data($0.utf8) } ?? Data()
        let result = payload.withUnsafeBytes {
          bunny_https_perform(operation.handle, url, method, $0.baseAddress, $0.count, limit, deadline)
        }
        let projected = Self.project(result)
        self?.control.async { [weak self] in
          guard let self, let slot = self.slots.removeValue(forKey: id) else { return }
          slot.timer.cancel()
          self.settle(slot, slot.expired ? Self.failure("timeout") : projected)
        }
      }
    }
  }

  private func stop(_ id: String, kind: String) {
    guard let slot = slots[id] else { return }
    slot.timer.cancel()
    if let operation = slot.operation {
      // Keep the place until curl has left its transfer loop and closed the easy handle.
      bunny_https_cancel(operation.handle)
    } else {
      slots.removeValue(forKey: id)
    }
    settle(slot, Self.failure(slot.expired ? "timeout" : kind))
  }

  private func settle(_ slot: Slot, _ result: [String: Any]) {
    let promise = slot.promise
    slot.promise = nil
    promise?.resolve(result)
  }

  private static func failure(_ kind: String) -> [String: Any] {
    ["ok": false, "kind": kind]
  }

  private static func project(_ result: BunnyHttpsResult) -> [String: Any] {
    switch result.outcome {
    case BunnyHttpsSuccess:
      let bytes = result.bytes.map { Data(bytesNoCopy: $0, count: result.size, deallocator: .free) } ?? Data()
      var field = result.content_type
      let contentType = withUnsafeBytes(of: &field) { buffer -> String? in
        guard let address = buffer.bindMemory(to: CChar.self).baseAddress, address.pointee != 0 else { return nil }
        return String(cString: address)
      }
      return ["ok": true, "status": Int(result.status),
              "contentType": contentType as Any? ?? NSNull(), "bytes": bytes]
    case BunnyHttpsTimeout: return failure("timeout")
    case BunnyHttpsRedirect: return failure("redirect")
    case BunnyHttpsResponse: return failure("response")
    case BunnyHttpsSize: return failure("size")
    default: return failure("network")
    }
  }

  private static func requestFields(url: String, method: String, headers: [String: String],
                                    body: String?) -> [String]? {
    guard ["GET", "POST", "DELETE"].contains(method), method == "POST" || body == nil,
          url.utf8.allSatisfy({ $0 > 32 && $0 < 127 && $0 != 92 }),
          let target = URLComponents(string: url), target.scheme?.lowercased() == "https",
          let host = target.host, !host.isEmpty, target.user == nil, target.password == nil,
          target.fragment == nil
    else { return nil }
    #if BUNNY_HTTPS_QUALIFICATION
    guard host == "localhost", let port = target.port,
          (29443...29447).contains(port) || port == 29449
    else { return nil }
    #endif
    var fields = ["Cache-Control: no-store", "Accept-Encoding: gzip, identity", "Expect:"]
    var names = Set<String>()
    for (header, value) in headers {
      let name = header.lowercased()
      guard ["accept", "content-type", "authorization"].contains(name),
            names.insert(name).inserted,
            !value.isEmpty, value.utf8.allSatisfy({ $0 >= 32 && $0 < 127 }),
            name != "authorization" || bunny_https_is_bearer_authorization(value)
      else { return nil }
      fields.append("\(name): \(value)")
    }
    if !names.contains("content-type") { fields.append("Content-Type:") }
    return fields
  }
}
