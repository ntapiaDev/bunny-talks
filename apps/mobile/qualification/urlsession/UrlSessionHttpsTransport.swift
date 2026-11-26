import ExpoModulesCore
import Foundation

// The qualification copy is the only target that includes this transport.
final class UrlSessionHttpsTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private final class Slot {
    let deadline: DispatchTime
    let timer: DispatchSourceTimer
    var task: URLSessionDataTask?
    var promise: Promise?
    var upload: Data?
    var response: HTTPURLResponse?
    var length: Int?
    var chunked = false
    var framedProtocol = false
    var limit = 0
    var bytes = Data()
    var failure: String?

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
        slot.promise?.resolve(failure("network"))
      }
      requests.removeAll()
      active.removeAll()
    }
  }

  func execute(id: String, url: String, method: String, headers: [String: String],
               body: String?, limit: Int, promise: Promise) {
    // Validate and prepare the upload outside the delegate queue.
    let request = makeRequest(url: url, method: method, headers: headers)
    let upload = body.map { Data($0.utf8) }
    queue.sync {
      guard let session, let slot = active[id], slot.task == nil else {
        promise.resolve(failure("network"))
        return
      }
      slot.promise = promise
      guard !slot.expired else {
        finish(id: id, slot: slot, result: failure("timeout"))
        return
      }
      guard (1...1_048_576).contains(limit), var request,
            (method == "GET" && upload == nil) || (method == "POST" && upload != nil)
      else {
        finish(id: id, slot: slot, result: failure("network"))
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
        finish(id: id, slot: slot, result: failure("timeout"))
        return
      }
      requests[task.taskIdentifier] = id
      task.resume()
    }
  }

  private func makeRequest(url: String, method: String, headers: [String: String]) -> URLRequest? {
    guard let target = URL(string: url), target.scheme == "https",
          target.host == "localhost", let port = target.port, (29443...29447).contains(port),
          target.user == nil, target.password == nil, target.query == nil, target.fragment == nil,
          target.path.hasPrefix("/v1/https-qualification/standard-json/")
    else { return nil }
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

  private func failure(_ kind: String) -> [String: Any] {
    ["ok": false, "kind": kind]
  }

  private func stop(id: String, kind: String) {
    guard let slot = active[id], slot.failure == nil else { return }
    slot.timer.cancel()
    slot.failure = kind
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
    let outcome = slot.expired ? failure("timeout") : slot.failure.map(failure) ?? result
    slot.promise?.resolve(outcome)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
    if let id = requests[task.taskIdentifier] { stop(id: id, kind: "redirect") }
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
    func reject(_ kind: String) {
      slot.failure = kind
      slot.bytes = Data()
      completionHandler(.cancel)
    }
    guard !slot.expired else { reject("timeout"); return }
    guard slot.response == nil, let response = response as? HTTPURLResponse,
          (200...599).contains(response.statusCode),
          response.mimeType?.lowercased() != "multipart/x-mixed-replace"
    else { reject("response"); return }
    guard !(300...399).contains(response.statusCode) else { reject("redirect"); return }
    guard response.value(forHTTPHeaderField: "Content-Encoding") == nil
    else { reject("response"); return }

    let transfer = response.value(forHTTPHeaderField: "Transfer-Encoding")?.lowercased()
    if let value = response.value(forHTTPHeaderField: "Content-Length") {
      guard transfer == nil, !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }),
            let length = Int(value), response.statusCode != 204 || length == 0
      else { reject("response"); return }
      guard length <= slot.limit else { reject("size"); return }
      slot.length = length
    } else if let transfer {
      guard transfer == "chunked", response.statusCode != 204 else { reject("response"); return }
      slot.chunked = true
    }
    if response.statusCode == 204 { slot.length = 0 }
    slot.response = response
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let id = requests[dataTask.taskIdentifier], let slot = active[id], slot.failure == nil
    else { return }
    if slot.expired {
      stop(id: id, kind: "timeout")
    } else if data.count > slot.limit - slot.bytes.count {
      stop(id: id, kind: "size")
    } else if let length = slot.length, data.count > length - slot.bytes.count {
      stop(id: id, kind: "response")
    } else {
      slot.bytes.append(data)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
    guard let id = requests[task.taskIdentifier], let slot = active[id] else { return }
    let name = metrics.transactionMetrics.last?.networkProtocolName
    slot.framedProtocol = name == "h2" || name == "h3"
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = requests[task.taskIdentifier], let slot = active[id] else { return }
    let result: [String: Any]
    if slot.failure != nil || slot.expired {
      result = failure("network")
    } else if let error {
      result = failure((error as? URLError)?.code == .timedOut ? "timeout" :
                       slot.response == nil ? "network" : "response")
    } else if let response = slot.response,
              slot.length.map({ $0 == slot.bytes.count }) ?? (slot.chunked || slot.framedProtocol) {
      result = ["ok": true, "status": response.statusCode,
                "contentType": response.value(forHTTPHeaderField: "Content-Type") as Any? ?? NSNull(),
                "bytes": slot.bytes]
    } else {
      result = failure("response")
    }
    finish(id: id, slot: slot, result: result)
  }
}
