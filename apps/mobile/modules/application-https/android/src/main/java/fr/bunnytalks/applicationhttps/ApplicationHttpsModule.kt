package fr.bunnytalks.applicationhttps

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import java.io.IOException
import java.net.ProtocolException
import java.util.UUID
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

private const val MAX_ACTIVE = 2

class ApplicationHttpsModule : Module() {
  private class Slot(val deadline: Long) {
    var timer: ScheduledFuture<*>? = null
    var claimed = false
    var call: Call? = null
    var stopped: String? = null
    fun remainingNanos(): Long = deadline - System.nanoTime()
  }

  private val lock = Any()
  private val active = mutableMapOf<String, Slot>()
  private val deadlines = ScheduledThreadPoolExecutor(1).apply { removeOnCancelPolicy = true }
  private val client = HttpsClient.create()

  override fun definition() = ModuleDefinition {
    Name("ApplicationHttps")
    if (BuildConfig.STANDARD_JSON_QUALIFICATION) {
      Function("qualificationProfile") { "standard-json-known-length-okhttp" }
    }
    OnDestroy { close() }
    // Reserve synchronously so cancellation can find the slot before Expo dispatches execute.
    Function("reserve") { timeoutMs: Int -> reserve(timeoutMs) }
    Function("cancel") { id: String -> stop(id, "network") }
    AsyncFunction("execute") {
        id: String, url: String, method: String, headers: Map<String, String>, body: String?,
        limit: Int, promise: Promise ->
      execute(id, url, method, headers, body, limit, promise)
    }
  }

  private fun reserve(timeoutMs: Int): String? {
    if (timeoutMs !in 1..120_000) return null
    val slot = Slot(System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs.toLong()))
    return synchronized(lock) {
      if (active.size >= MAX_ACTIVE || deadlines.isShutdown) return null
      val id = UUID.randomUUID().toString()
      val remaining = slot.remainingNanos()
      if (remaining <= 0) return null
      slot.timer = deadlines.schedule({ stop(id, "timeout") }, remaining, TimeUnit.NANOSECONDS)
      active[id] = slot
      id
    }
  }

  private fun stop(id: String, kind: String) {
    val call = synchronized(lock) {
      val slot = active[id] ?: return
      if (slot.stopped != null) return
      slot.stopped = kind
      slot.timer?.cancel(false)
      if (!slot.claimed) active.remove(id)
      slot.call
    }
    call?.cancel()
  }

  private fun close() {
    val calls = synchronized(lock) {
      val calls = active.values.mapNotNull { it.call }
      active.clear()
      deadlines.shutdownNow()
      calls
    }
    calls.forEach { it.cancel() }
    client.connectionPool.evictAll()
  }

  private fun execute(
    id: String, url: String, method: String, headers: Map<String, String>,
    body: String?, limit: Int, promise: Promise
  ) {
    val slot = synchronized(lock) {
      if (deadlines.isShutdown) return
      val slot = active[id]
      if (slot == null || slot.claimed) {
        promise.resolve(failure("network"))
        return
      }
      if (slot.remainingNanos() <= 0) {
        finish(id, promise, failure("timeout"))
        return
      }
      slot.claimed = true
      slot
    }
    val request = try {
      require(limit in 1..MAX_RESPONSE_BYTES)
      HttpsClient.request(url, method, headers, body)
    } catch (_: Exception) {
      finish(id, promise, failure("network"))
      return
    }
    synchronized(lock) {
      if (active[id] !== slot) return
      if (slot.stopped != null || slot.remainingNanos() <= 0) {
        finish(id, promise, failure("timeout"))
        return
      }
      try {
        val call = client.newCall(request)
        // The reservation timer covers waiting and preparation. OkHttp also
        // enforces the same absolute deadline once it runs the call.
        call.timeout().deadlineNanoTime(slot.deadline)
        slot.call = call
        call.enqueue(object : Callback {
          override fun onFailure(call: Call, e: IOException) {
            finish(id, promise, failure(if (e is ProtocolException) "response" else "network"))
          }

          override fun onResponse(call: Call, response: Response) {
            val result = try {
              HttpsClient.read(call, response, limit)
            } catch (_: Exception) {
              call.cancel()
              failure("response")
            }
            finish(id, promise, result)
          }
        })
      } catch (_: Exception) {
        slot.call?.cancel()
        finish(id, promise, failure("network"))
      }
    }
  }

  private fun finish(id: String, promise: Promise, result: Map<String, Any?>) {
    synchronized(lock) {
      val slot = active.remove(id) ?: return
      slot.timer?.cancel(false)
      val stopped = slot.stopped
      val finalResult = if (stopped != null) failure(stopped)
        else if (slot.remainingNanos() <= 0) failure("timeout")
        else result
      // Expo enqueues delivery on the JS invoker. Commit it before close can clear the slot.
      promise.resolve(finalResult)
    }
  }
}
