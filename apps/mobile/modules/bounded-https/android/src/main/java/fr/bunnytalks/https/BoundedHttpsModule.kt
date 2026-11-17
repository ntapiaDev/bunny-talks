package fr.bunnytalks.https

import android.content.pm.ApplicationInfo
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class BoundedHttpsModule : Module() {
  private val lock = Any()
  private data class Entry(val call: Call, val limit: Int, var reading: Boolean = false)
  private val active = mutableMapOf<String, Entry>()
  private val client = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false)
    .cookieJar(CookieJar.NO_COOKIES)
    .authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
    .cache(null).retryOnConnectionFailure(false)
    .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
    .build()

  override fun definition() = ModuleDefinition {
    Name("BoundedHttps")
    OnDestroy { synchronized(lock) { active.values.forEach { it.call.cancel() }; active.clear() } }
    // Synchronous start registers the Call before JS can invoke cancel(id).
    Function("start") { id: String, url: String, method: String, limit: Int, timeout: Int ->
      check((appContext.reactContext!!.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
      require(id.matches(Regex("[a-z0-9-]{1,64}")))
      require(limit in 1..1048576 && timeout in 1..120000)
      require(method == "GET" || method == "POST")
      val request = Request.Builder().url(url)
      require(request.build().url.isHttps && request.build().url.username.isEmpty() && request.build().url.password.isEmpty())
      require(request.build().url.host == "10.0.2.2" && request.build().url.port in 9443..9447)
      request.header("Accept", "application/json").header("Authorization", "Bearer fixture-only")
        .header("Cache-Control", "no-store")
        .method(method, if (method == "POST") "{}".toRequestBody() else null)
      synchronized(lock) {
        check(active.size < 2 && !active.containsKey(id))
        val call = client.newCall(request.build())
        call.timeout().timeout(timeout.toLong(), TimeUnit.MILLISECONDS)
        active[id] = Entry(call, limit)
      }
    }
    AsyncFunction("read") { id: String, promise: Promise ->
      val entry = synchronized(lock) { active[id]?.takeIf { !it.reading }?.also { it.reading = true } }
      if (entry == null) {
        promise.reject("ERR_CONFIGURATION", "HTTPS configuration", null)
      } else {
        val call = entry.call
        val limit = entry.limit
        // read() must be invoked once. No queue: at most two registered calls.
        call.enqueue(object : Callback {
          override fun onFailure(call: Call, e: IOException) {
            synchronized(lock) { active.remove(id) }
            promise.reject("ERR_NETWORK", "HTTPS network", null)
          }
          override fun onResponse(call: Call, response: okhttp3.Response) {
            val result = try {
              response.use {
                if (it.code in 300..399) throw IOException("redirect")
                // OkHttp transparently decodes gzip. Reject other encodings.
                if (it.header("Content-Encoding") != null) throw IOException("encoding")
                val bytes = BoundedBodyReader.read(it.body!!.byteStream(), limit)
                if (call.isCanceled()) throw IOException("canceled")
                mapOf("status" to it.code, "contentType" to it.header("Content-Type"),
                  "bytes" to bytes)
              }
            } catch (e: Exception) {
              val kind = when (e.message) { "size" -> "SIZE"; "redirect" -> "REDIRECT"; else -> "NETWORK" }
              call.cancel()
              synchronized(lock) { active.remove(id) }
              promise.reject("ERR_$kind", "HTTPS ${kind.lowercase()}", null)
              return
            }
            synchronized(lock) { active.remove(id) }
            promise.resolve(result)
          }
        })
      }
    }
    Function("cancel") { id: String -> synchronized(lock) { active[id]?.let { it.call.cancel(); if (!it.reading) active.remove(id) } }; Unit }
  }
}
