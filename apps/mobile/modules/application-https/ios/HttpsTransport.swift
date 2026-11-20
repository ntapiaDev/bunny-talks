import ExpoModulesCore
import Foundation

private let maximumResponseBytes = 1_048_576
private let maximumActiveRequests = 2

final class HttpsTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private final class Slot {
    let deadline: DispatchTime
    let timer: DispatchSourceTimer
    var task: URLSessionDataTask?
    var session: URLSession?
    var promise: Promise?
    var response: HTTPURLResponse?
    var expectedLength: Int?
    var hasExplicitFraming = false
    var networkProtocol: String?
    var limit = 0
    var bytes = Data()
    var failure: String?
    #if BUNNY_HTTPS_QUALIFICATION
    let qualificationStart = DispatchTime.now().uptimeNanoseconds
    var qualificationTrace: [String] = []
    var recordedFirstData = false
    #endif

    init(deadline: DispatchTime, timer: DispatchSourceTimer) {
      self.deadline = deadline
      self.timer = timer
    }

    var expired: Bool { DispatchTime.now() >= deadline }
  }

  // The same serial queue owns reservations, timers, and every URLSession delegate callback.
  private let queue: DispatchQueue
  private let delegates: OperationQueue
  private var active: [String: Slot] = [:]
  private var requests: [ObjectIdentifier: String] = [:]
  private var closed = false

  override init() {
    let queue = DispatchQueue(label: "fr.bunnytalks.applicationhttps")
    let delegates = OperationQueue()
    delegates.maxConcurrentOperationCount = 1
    delegates.underlyingQueue = queue
    self.queue = queue
    self.delegates = delegates
    super.init()
  }

  func reserve(timeoutMs: Int) -> String? {
    queue.sync {
      guard !closed, (1...120_000).contains(timeoutMs), active.count < maximumActiveRequests
      else { return nil }
      let id = UUID().uuidString
      let deadline = DispatchTime.now() + .milliseconds(timeoutMs)
      let timer = DispatchSource.makeTimerSource(queue: queue)
      active[id] = Slot(deadline: deadline, timer: timer)
      timer.schedule(deadline: deadline)
      timer.setEventHandler { [weak self] in self?.stop(id: id, kind: "timeout") }
      timer.resume()
      return id
    }
  }

  func cancel(id: String) {
    queue.sync { stop(id: id, kind: "network") }
  }

  func close() {
    queue.sync {
      closed = true
      for slot in active.values {
        slot.timer.cancel()
        slot.session?.invalidateAndCancel()
        mark(slot, "destroy")
        resolve(slot, failure("network"))
      }
      requests.removeAll()
      active.removeAll()
    }
  }

  func execute(id: String, url: String, method: String, headers: [String: String],
               body: String?, limit: Int, promise: Promise) {
    queue.sync {
      guard let slot = active[id], slot.task == nil else {
        var result = failure("network")
        #if BUNNY_HTTPS_QUALIFICATION
        result["qualificationTrace"] = "missing-slot:0,resolve-network:0"
        #endif
        promise.resolve(result)
        return
      }
      slot.promise = promise
      mark(slot, "execute")
      guard !slot.expired else {
        finish(id: id, slot: slot, result: failure("timeout"))
        return
      }
      guard (1...maximumResponseBytes).contains(limit),
            let request = makeRequest(url: url, method: method, headers: headers, body: body)
      else {
        finish(id: id, slot: slot, result: failure("network"))
        return
      }

      let configuration = URLSessionConfiguration.ephemeral
      configuration.httpShouldSetCookies = false
      configuration.httpCookieStorage = nil
      configuration.httpCookieAcceptPolicy = .never
      configuration.urlCredentialStorage = nil
      configuration.urlCache = nil
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      configuration.waitsForConnectivity = false
      let now = DispatchTime.now().uptimeNanoseconds
      guard now < slot.deadline.uptimeNanoseconds else {
        finish(id: id, slot: slot, result: failure("timeout"))
        return
      }
      let remaining = TimeInterval(slot.deadline.uptimeNanoseconds - now) / 1_000_000_000
      configuration.timeoutIntervalForRequest = remaining
      configuration.timeoutIntervalForResource = remaining

      let session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegates)
      let task = session.dataTask(with: request)
      slot.session = session
      slot.task = task
      slot.limit = limit
      requests[ObjectIdentifier(session)] = id

      // Task creation and registration run on the timer's queue and consume the same budget.
      guard !slot.expired else {
        task.cancel()
        finish(id: id, slot: slot, result: failure("timeout"))
        return
      }
      mark(slot, "resume")
      task.resume()
    }
  }

  private func makeRequest(url: String, method: String, headers: [String: String],
                           body: String?) -> URLRequest? {
    guard ["GET", "POST", "DELETE"].contains(method), method == "POST" || body == nil,
          let target = URL(string: url), target.scheme?.lowercased() == "https",
          let host = target.host, !host.isEmpty, target.user == nil, target.password == nil,
          target.fragment == nil
    else { return nil }
    #if BUNNY_HTTPS_QUALIFICATION
    // This build can use only the synthetic loopback fixture.
    guard host == "localhost", let port = target.port,
          (29443...29447).contains(port) || port == 29449
    else { return nil }
    #endif
    var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpMethod = method
    request.httpShouldHandleCookies = false
    for (name, value) in headers {
      guard ["accept", "content-type", "authorization"].contains(name.lowercased()),
            !value.contains("\r"), !value.contains("\n") else { return nil }
      request.setValue(value, forHTTPHeaderField: name)
    }
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
    #if BUNNY_HTTPS_QUALIFICATION
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    #else
    request.setValue("gzip", forHTTPHeaderField: "Accept-Encoding")
    #endif
    if let body { request.httpBody = Data(body.utf8) }
    return request
  }

  private func failure(_ kind: String) -> [String: Any] {
    ["ok": false, "kind": kind]
  }

  private func mark(_ slot: Slot, _ event: String) {
    #if BUNNY_HTTPS_QUALIFICATION
    // Reserve the last cell for resolution even if a callback is repeated.
    guard slot.qualificationTrace.count < 23 else { return }
    let millis = (DispatchTime.now().uptimeNanoseconds - slot.qualificationStart) / 1_000_000
    slot.qualificationTrace.append("\(event):\(min(millis, 120_000))")
    #endif
  }

  #if BUNNY_HTTPS_QUALIFICATION
  private func codingCategory(_ value: String?) -> String {
    switch value?.lowercased() {
    case nil: return "absent"
    case "identity": return "identity"
    case "gzip": return "gzip"
    case let value? where value.contains(","): return "stacked"
    default: return "other"
    }
  }

  private func lengthCategory(_ value: String?) -> String {
    guard let value else { return "absent" }
    return Int(value).map { $0 >= 0 } == true ? "valid" : "invalid"
  }

  private func transferCategory(_ value: String?) -> String {
    guard let value = value?.lowercased() else { return "absent" }
    if value == "chunked" { return "chunked" }
    if value.isEmpty { return "empty" }
    let trimmed = value.trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
    if trimmed.isEmpty { return "whitespace" }
    if trimmed == "chunked" { return "ows" }
    if trimmed == "identity" { return "identity" }
    if trimmed.contains(",") { return "list" }
    return "unrecognized"
  }

  private func classifyHeaders(_ response: HTTPURLResponse, slot: Slot) {
    let fields = response.allHeaderFields
    let categories: [(String, String, (String?) -> String)] = [
      ("Content-Encoding", "coding", codingCategory),
      ("Content-Length", "length", lengthCategory),
      ("Transfer-Encoding", "transfer", transferCategory),
    ]
    var agree = true
    for (name, tag, classify) in categories {
      let matches = fields.filter { ($0.key.base as? String)?.lowercased() == name.lowercased() }
      if matches.count > 1 {
        mark(slot, "map-\(tag)-ambiguous")
        agree = false
      } else if let field = matches.first, !(field.value is String) {
        mark(slot, "map-\(tag)-nonstring")
        agree = false
      } else {
        let value = matches.first?.value as? String
        mark(slot, "map-\(tag)-\(classify(value))")
        agree = agree && value == response.value(forHTTPHeaderField: name)
      }
    }
    mark(slot, agree ? "headers-match" : "headers-diverge")
    let expected = response.expectedContentLength
    mark(slot, expected < 0 ? "expected-length-unknown" :
         expected > Int64(slot.limit) ? "expected-length-over" : "expected-length-within")
  }
  #endif

  private func resolve(_ slot: Slot, _ result: [String: Any]) {
    #if BUNNY_HTTPS_QUALIFICATION
    let millis = (DispatchTime.now().uptimeNanoseconds - slot.qualificationStart) / 1_000_000
    let outcome = result["kind"] as? String ?? "success"
    slot.qualificationTrace.append("resolve-\(outcome):\(min(millis, 120_000))")
    var traced = result
    traced["qualificationTrace"] = slot.qualificationTrace.joined(separator: ",")
    slot.promise?.resolve(traced)
    #else
    slot.promise?.resolve(result)
    #endif
  }

  private func stop(id: String, kind: String) {
    guard let slot = active[id] else { return }
    switch kind {
    case "network": mark(slot, "cancel")
    case "timeout": mark(slot, "deadline")
    case "size": mark(slot, "body-size")
    case "response": mark(slot, "body-length")
    case "redirect": mark(slot, "redirect")
    default: break
    }
    slot.timer.cancel()
    slot.failure = slot.failure ?? kind
    slot.bytes = Data()
    if let task = slot.task {
      // Keep the slot until URLSession acknowledges completion.
      task.cancel()
    } else {
      active.removeValue(forKey: id)
    }
  }

  private func finish(id: String, slot: Slot, result: [String: Any]) {
    active.removeValue(forKey: id)
    slot.timer.cancel()
    if let session = slot.session {
      requests.removeValue(forKey: ObjectIdentifier(session))
      session.finishTasksAndInvalidate()
    }
    if slot.expired {
      resolve(slot, failure("timeout"))
    } else if let kind = slot.failure {
      resolve(slot, failure(kind))
    } else {
      resolve(slot, result)
    }
  }

  private func id(for session: URLSession) -> String? {
    requests[ObjectIdentifier(session)]
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
    if let id = id(for: session) { stop(id: id, kind: "redirect") }
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    handle(challenge, completionHandler: completionHandler)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    handle(challenge, completionHandler: completionHandler)
  }

  private func handle(_ challenge: URLAuthenticationChallenge,
                      completionHandler: (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
      completionHandler(.performDefaultHandling, nil)
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
                  needNewBodyStream completionHandler: @escaping (InputStream?) -> Void) {
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let id = id(for: session), let slot = active[id], slot.failure == nil else {
      completionHandler(.cancel)
      return
    }
    mark(slot, "headers")
    func reject(_ kind: String, _ reason: String) {
      mark(slot, reason)
      slot.failure = kind
      slot.bytes = Data()
      completionHandler(.cancel)
    }
    // Foundation can deliver a response notification per part of a mixed-replace stream.
    guard slot.response == nil,
          let response = response as? HTTPURLResponse,
          (100...599).contains(response.statusCode)
    else { reject("response", "reject-response"); return }
    guard !(300...399).contains(response.statusCode) else { reject("redirect", "redirect"); return }
    guard response.mimeType?.lowercased() != "multipart/x-mixed-replace"
    else { reject("response", "reject-multipart"); return }

    let encoding = response.value(forHTTPHeaderField: "Content-Encoding")?.lowercased()
    let transferEncoding = response.value(forHTTPHeaderField: "Transfer-Encoding")?.lowercased()
    let rawLength = response.value(forHTTPHeaderField: "Content-Length")
    #if BUNNY_HTTPS_QUALIFICATION
    mark(slot, "coding-\(codingCategory(encoding))")
    mark(slot, "length-\(lengthCategory(rawLength))")
    let transfer = transferCategory(transferEncoding)
    if transfer == "absent" || transfer == "chunked" {
      mark(slot, "transfer-\(transfer)")
    } else {
      mark(slot, "transfer-other")
      mark(slot, "transfer-\(transfer)")
    }
    classifyHeaders(response, slot: slot)
    // Content-Encoding can be normalized before reaching the delegate. An absent
    // field cannot prove identity for a response that can carry a body.
    guard encoding == "identity" || (response.statusCode == 204 && encoding == nil)
    else { reject("response", "reject-coding"); return }
    #else
    guard encoding == nil || encoding == "identity" || encoding == "gzip"
    else { reject("response", "reject-coding"); return }
    #endif

    if let raw = rawLength {
      guard transferEncoding == nil else { reject("response", "reject-length-transfer"); return }
      guard let length = Int(raw), length >= 0 else { reject("response", "reject-length"); return }
      guard response.statusCode != 204 || length == 0 else { reject("response", "reject-204-length"); return }
      slot.hasExplicitFraming = true
      // For gzip, Content-Length describes the encoded body. The delegate receives decoded bytes.
      if encoding != "gzip" {
        guard length <= slot.limit else { reject("size", "reject-size"); return }
        slot.expectedLength = length
      }
    } else if let transferEncoding {
      guard transferEncoding == "chunked" else { reject("response", "reject-transfer"); return }
      slot.hasExplicitFraming = true
    }
    if response.statusCode == 204 {
      slot.expectedLength = 0
      slot.hasExplicitFraming = true
    }
    slot.response = response
    mark(slot, "allow")
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    #if BUNNY_HTTPS_QUALIFICATION
    if let id = id(for: session), let slot = active[id], !data.isEmpty && !slot.recordedFirstData {
      slot.recordedFirstData = true
      mark(slot, slot.failure == nil ? "first-data" : "late-data")
    }
    #endif
    guard let id = id(for: session), let slot = active[id], slot.failure == nil else { return }
    if slot.expired {
      stop(id: id, kind: "timeout")
    } else if data.count > slot.limit - slot.bytes.count {
      #if BUNNY_HTTPS_QUALIFICATION
      if !slot.bytes.isEmpty && data.count - (slot.limit - slot.bytes.count) == 1 {
        mark(slot, "body-extra-one")
      }
      #endif
      stop(id: id, kind: "size")
    } else if let length = slot.expectedLength, data.count > length - slot.bytes.count {
      stop(id: id, kind: "response")
    } else {
      slot.bytes.append(data)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
    guard let id = id(for: session), let slot = active[id] else { return }
    slot.networkProtocol = metrics.transactionMetrics.last?.networkProtocolName
    #if BUNNY_HTTPS_QUALIFICATION
    switch metrics.transactionMetrics.count {
    case 0: mark(slot, "transactions-none")
    case 1: mark(slot, "transactions-one")
    default: mark(slot, "transactions-multiple")
    }
    switch slot.networkProtocol {
    case "http/1.1": mark(slot, "protocol-http-one")
    case "h2": mark(slot, "protocol-h2")
    case "h3": mark(slot, "protocol-h3")
    default: mark(slot, "protocol-unconfirmed")
    }
    #endif
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = id(for: session), let slot = active[id] else { return }
    #if BUNNY_HTTPS_QUALIFICATION
    if !slot.recordedFirstData { mark(slot, "delegate-empty") }
    #endif
    let result: [String: Any]
    if let error {
      switch (error as? URLError)?.code {
      case .timedOut: mark(slot, "complete-timeout")
      case .cancelled: mark(slot, "complete-cancelled")
      default: mark(slot, "complete-error")
      }
      result = failure((error as? URLError)?.code == .timedOut ? "timeout" :
                       slot.response == nil ? "network" : "response")
    } else if let response = slot.response,
              slot.hasExplicitFraming || slot.networkProtocol == "h2" || slot.networkProtocol == "h3",
              slot.expectedLength.map({ $0 == slot.bytes.count }) ?? true {
      mark(slot, "complete-ok")
      result = ["ok": true, "status": response.statusCode,
                "contentType": response.value(forHTTPHeaderField: "Content-Type") as Any? ?? NSNull(),
                "bytes": slot.bytes]
    } else {
      mark(slot, slot.response == nil ? "complete-no-response" :
           slot.expectedLength.map { $0 != slot.bytes.count } == true ? "complete-length" : "complete-framing")
      result = failure("response")
    }
    finish(id: id, slot: slot, result: result)
  }
}
