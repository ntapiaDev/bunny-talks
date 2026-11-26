import ExpoModulesCore
import Foundation

final class UrlSessionHttpsTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private final class Slot {
    let deadline: DispatchTime
    let timer: DispatchSourceTimer
    var task: URLSessionDataTask?
    var promise: Promise?
    var upload: Data?
    var response: HTTPURLResponse?
    var length: Int?
    var limit = 0
    var bytes = Data()
    var failure: String?
    #if BUNNY_HTTPS_URLSESSION_QUALIFICATION
    var qualificationReason: String?
    var qualificationStatus: Int?
    var qualificationBytes: Int?
    #endif

    init(deadline: DispatchTime, timer: DispatchSourceTimer) {
      self.deadline = deadline
      self.timer = timer
    }

    var expired: Bool { DispatchTime.now() >= deadline }
  }

  // Reservations, timers and Foundation delegates share the same serial queue.
  private let queue = DispatchQueue(label: "fr.bunnytalks.applicationhttps.urlsession")
  private var session: URLSession?
  private var active: [String: Slot] = [:]
  private var requests: [Int: String] = [:]

  #if !BUNNY_HTTPS_URLSESSION_QUALIFICATION
  private let approvedOrigin: URLComponents? = {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "BunnyApplicationHttpsOrigin") as? String,
          let origin = URLComponents(string: value), origin.scheme == "https",
          let host = origin.host, !host.isEmpty, origin.percentEncodedHost?.contains("%") == false,
          origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
          origin.path.isEmpty || origin.path == "/",
          (1...65535).contains(origin.port ?? 443)
    else { return nil }
    return origin
  }()
  #endif

  override init() {
    super.init()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.httpCookieAcceptPolicy = .never
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.waitsForConnectivity = false
    configuration.timeoutIntervalForRequest = 120
    configuration.timeoutIntervalForResource = 120
    let delegates = OperationQueue()
    delegates.maxConcurrentOperationCount = 1
    delegates.underlyingQueue = queue
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegates)
  }

  func reserve(timeoutMs: Int) -> String? {
    guard (1...120_000).contains(timeoutMs) else { return nil }
    let deadline = DispatchTime.now() + .milliseconds(timeoutMs)
    return queue.sync {
      guard session != nil, active.count < 2,
            DispatchTime.now() < deadline else { return nil }
      let id = UUID().uuidString
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
      let closing = session
      session = nil
      closing?.invalidateAndCancel()
      for slot in active.values {
        slot.timer.cancel()
        slot.promise?.resolve(failure("network", reason: "network", slot: slot))
      }
      requests.removeAll()
      active.removeAll()
    }
  }

  func execute(id: String, url: String, method: String, headers: [String: String],
               body: String?, limit: Int, promise: Promise) {
    // Validate and prepare the upload outside the delegate queue.
    let request = makeRequest(url: url, method: method, headers: headers)
    // Mutations use the same one-shot stream, including a bodyless DELETE.
    let upload = method == "GET" ? nil : Data((body ?? "").utf8)
    queue.sync {
      guard let session, let slot = active[id], slot.task == nil else {
        promise.resolve(failure("network", reason: "reservation"))
        return
      }
      slot.promise = promise
      guard !slot.expired else {
        finish(id: id, slot: slot, result: failure("timeout", reason: "deadline"))
        return
      }
      guard (1...1_048_576).contains(limit), var request,
            (method == "POST") == (body != nil)
      else {
        finish(id: id, slot: slot, result: failure("network", reason: "request"))
        return
      }

      let task: URLSessionDataTask
      if let upload {
        request.setValue(String(upload.count), forHTTPHeaderField: "Content-Length")
        slot.upload = upload
        task = session.uploadTask(withStreamedRequest: request)
      } else {
        task = session.dataTask(with: request)
      }
      slot.task = task
      slot.limit = limit
      if slot.expired {
        task.cancel()
        finish(id: id, slot: slot, result: failure("timeout", reason: "deadline"))
        return
      }
      requests[task.taskIdentifier] = id
      task.resume()
    }
  }

  private func makeRequest(url: String, method: String, headers: [String: String]) -> URLRequest? {
    guard let components = URLComponents(string: url), components.scheme == "https",
          components.user == nil, components.password == nil, components.query == nil,
          components.fragment == nil, let target = components.url,
          let host = components.host, let encodedHost = components.percentEncodedHost,
          !encodedHost.contains("%"), (1...65535).contains(components.port ?? 443),
          components.percentEncodedPath.range(of: #"^/v1/[a-z0-9-]+(?:/[a-z0-9-]+)*$"#,
                                            options: .regularExpression) != nil,
          ["GET", "POST", "DELETE"].contains(method)
    else { return nil }
    #if BUNNY_HTTPS_URLSESSION_QUALIFICATION
    guard host == "localhost", let port = components.port, (29443...29447).contains(port),
          components.path.hasPrefix("/v1/https-qualification/standard-json/")
    else { return nil }
    #else
    guard let origin = approvedOrigin, host.lowercased() == origin.host?.lowercased(),
          (components.port ?? 443) == (origin.port ?? 443),
          method == "POST" || components.path == "/v1/session"
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
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    return request
  }

  private func failure(_ kind: String, reason: String, slot: Slot? = nil) -> [String: Any] {
    #if BUNNY_HTTPS_URLSESSION_QUALIFICATION
    var result: [String: Any] = ["ok": false, "kind": kind, "qualificationReason": reason]
    result["qualificationStatus"] = slot?.qualificationStatus
    result["qualificationBytes"] = slot?.qualificationBytes
    return result
    #else
    return ["ok": false, "kind": kind]
    #endif
  }

  private func stop(id: String, kind: String, reason: String = "network") {
    guard let slot = active[id], slot.failure == nil else { return }
    slot.timer.cancel()
    slot.failure = kind
    #if BUNNY_HTTPS_URLSESSION_QUALIFICATION
    slot.qualificationReason = kind == "timeout" ? "deadline" : reason
    #endif
    slot.bytes = Data()
    slot.upload = nil
    if let task = slot.task {
      // Keep the reservation until Foundation acknowledges completion.
      task.cancel()
    } else {
      active.removeValue(forKey: id)
    }
  }

  private func finish(id: String, slot: Slot, result: [String: Any]) {
    active.removeValue(forKey: id)
    slot.timer.cancel()
    if let task = slot.task { requests.removeValue(forKey: task.taskIdentifier) }
    #if BUNNY_HTTPS_URLSESSION_QUALIFICATION
    let reason = slot.qualificationReason ?? "network"
    #else
    let reason = "network"
    #endif
    let outcome = slot.expired ? failure("timeout", reason: "deadline", slot: slot)
      : slot.failure.map { failure($0, reason: reason, slot: slot) } ?? result
    slot.promise?.resolve(outcome)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
    if let id = requests[task.taskIdentifier] {
      #if BUNNY_HTTPS_URLSESSION_QUALIFICATION
      active[id]?.qualificationStatus = response.statusCode
      active[id]?.qualificationBytes = 0
      #endif
      stop(id: id, kind: "redirect", reason: "redirect")
    }
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
    let isServerTrust = challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
    completionHandler(isServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
                  needNewBodyStream completionHandler: @escaping (InputStream?) -> Void) {
    guard let id = requests[task.taskIdentifier], let slot = active[id],
          !slot.expired, let upload = slot.upload else {
      completionHandler(nil)
      if let id = requests[task.taskIdentifier] { stop(id: id, kind: "network") }
      return
    }
    slot.upload = nil
    completionHandler(InputStream(data: upload))
  }

  @available(iOS 17.0, *)
  func urlSession(_ session: URLSession, task: URLSessionTask, needNewBodyStreamFrom offset: Int64,
                  completionHandler: @escaping (InputStream?) -> Void) {
    guard offset == 0 else {
      completionHandler(nil)
      if let id = requests[task.taskIdentifier] { stop(id: id, kind: "network") }
      return
    }
    urlSession(session, task: task, needNewBodyStream: completionHandler)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let id = requests[dataTask.taskIdentifier], let slot = active[id], slot.failure == nil else {
      completionHandler(.cancel)
      return
    }
    #if BUNNY_HTTPS_URLSESSION_QUALIFICATION
    slot.qualificationStatus = (response as? HTTPURLResponse)?.statusCode
    slot.qualificationBytes = 0
    #endif
    func reject(_ kind: String, reason: String) {
      slot.failure = kind
      #if BUNNY_HTTPS_URLSESSION_QUALIFICATION
      slot.qualificationReason = reason
      #endif
      slot.bytes = Data()
      completionHandler(.cancel)
    }
    guard !slot.expired else { reject("timeout", reason: "deadline"); return }
    guard slot.response == nil, let response = response as? HTTPURLResponse,
          (200...599).contains(response.statusCode),
          response.mimeType?.lowercased() != "multipart/x-mixed-replace"
    else { reject("response", reason: "headers"); return }
    guard !(300...399).contains(response.statusCode) else { reject("redirect", reason: "redirect"); return }
    guard response.value(forHTTPHeaderField: "Content-Encoding") == nil
    else { reject("response", reason: "coding"); return }

    guard response.value(forHTTPHeaderField: "Transfer-Encoding") == nil
    else { reject("response", reason: "framing"); return }
    let declaredLength = response.value(forHTTPHeaderField: "Content-Length")
    if response.statusCode == 204 {
      guard declaredLength == nil else { reject("response", reason: "framing"); return }
      slot.length = 0
    } else {
      guard let value = declaredLength, !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }),
            let length = Int(value)
      else { reject("response", reason: "framing"); return }
      guard length <= slot.limit else { reject("size", reason: "framing"); return }
      slot.length = length
    }
    slot.response = response
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let id = requests[dataTask.taskIdentifier], let slot = active[id], slot.failure == nil
    else { return }
    #if BUNNY_HTTPS_URLSESSION_QUALIFICATION
    // The extra value means that the native delegate received more than the body limit.
    slot.qualificationBytes = slot.bytes.count + min(data.count, slot.limit + 1 - slot.bytes.count)
    #endif
    if slot.expired {
      stop(id: id, kind: "timeout")
    } else if data.count > slot.limit - slot.bytes.count {
      stop(id: id, kind: "size", reason: "body")
    } else if let length = slot.length, data.count > length - slot.bytes.count {
      stop(id: id, kind: "response", reason: "body")
    } else {
      slot.bytes.append(data)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = requests[task.taskIdentifier], let slot = active[id] else { return }
    let result: [String: Any]
    if slot.failure != nil || slot.expired {
      result = failure("network", reason: "network", slot: slot)
    } else if let error {
      let code = (error as? URLError)?.code
      if code == .timedOut {
        result = failure("timeout", reason: "deadline", slot: slot)
      } else if slot.response != nil {
        result = failure("response", reason: "body", slot: slot)
      } else {
        #if BUNNY_HTTPS_URLSESSION_QUALIFICATION
        let tlsCodes: [URLError.Code] = [.secureConnectionFailed, .serverCertificateHasBadDate,
          .serverCertificateUntrusted, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid,
          .clientCertificateRejected, .clientCertificateRequired]
        result = failure("network", reason: code.map { tlsCodes.contains($0) } == true ? "tls" : "network", slot: slot)
        #else
        result = failure("network", reason: "network")
        #endif
      }
    } else if let response = slot.response, let length = slot.length, length == slot.bytes.count {
      result = ["ok": true, "status": response.statusCode,
                "contentType": response.value(forHTTPHeaderField: "Content-Type") as Any? ?? NSNull(),
                "bytes": slot.bytes]
    } else {
      result = failure("response", reason: slot.response == nil ? "headers" : "framing", slot: slot)
    }
    finish(id: id, slot: slot, result: result)
  }
}
