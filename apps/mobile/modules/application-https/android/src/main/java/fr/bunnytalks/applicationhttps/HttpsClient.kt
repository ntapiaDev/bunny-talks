package fr.bunnytalks.applicationhttps

import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.Proxy
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal fun failure(kind: String): Map<String, Any?> = mapOf("ok" to false, "kind" to kind)

internal object HttpsClient {
  private val methods = setOf("GET", "POST", "DELETE")
  private val allowedHeaders = setOf("accept", "authorization", "content-type")

  fun create(): OkHttpClient = OkHttpClient.Builder()
    .followRedirects(false)
    .followSslRedirects(false)
    .cookieJar(CookieJar.NO_COOKIES)
    .authenticator(Authenticator.NONE)
    .proxyAuthenticator(Authenticator.NONE)
    .proxy(Proxy.NO_PROXY)
    .cache(null)
    .retryOnConnectionFailure(false)
    .connectionPool(ConnectionPool())
    // A single native total deadline owns all phases.
    .connectTimeout(0, TimeUnit.MILLISECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .writeTimeout(0, TimeUnit.MILLISECONDS)
    .addNetworkInterceptor { chain ->
      val request = chain.request()
      val sent = request.tag(AtomicBoolean::class.java) ?: throw IOException()
      if (!sent.compareAndSet(false, true)) throw IOException()

      val response = chain.proceed(request)
      // OkHttp can follow an immediate 503 even with retryOnConnectionFailure(false).
      // Retry-After is outside the transport's response envelope.
      if (response.code == 503) response.newBuilder().removeHeader("Retry-After").build()
      else response
    }
    .build()

  fun request(url: String, method: String, headers: Map<String, String>, body: String?): Request {
    require(method in methods && (method == "POST" || body == null))
    val target = url.toHttpUrl()
    require(target.isHttps && target.username.isEmpty() && target.password.isEmpty() &&
            target.fragment == null && target.query == null)
    val builder = Request.Builder().url(target)
    for ((name, value) in headers) {
      require(name.lowercase(Locale.ROOT) in allowedHeaders)
      builder.header(name, value)
    }
    builder.header("Cache-Control", "no-store")
    if (BuildConfig.STANDARD_JSON_QUALIFICATION) {
      require(target.host == "10.0.2.2" && target.port in 29443..29447 &&
              target.encodedPath.startsWith("/v1/https-qualification/standard-json/"))
    }
    // An explicit request header disables OkHttp's transparent gzip decoder.
    builder.header("Accept-Encoding", "identity")
    return builder
      .tag(AtomicBoolean::class.java, AtomicBoolean())
      .method(method, if (method == "POST") (body ?: "").toByteArray().toRequestBody() else null)
      .build()
  }

  fun read(call: Call, response: Response, limit: Int): Map<String, Any?> = response.use {
    try {
      if (it.code in 300..399) {
        call.cancel()
        return failure("redirect")
      }
      if (it.headers("Content-Encoding").isNotEmpty()) throw IOException()
      val body = it.body ?: throw IOException()
      val length = knownLength(it)
      val bytes = BoundedBodyReader.read(body.byteStream(), limit, length)
      mapOf("ok" to true, "status" to it.code, "contentType" to it.header("Content-Type"), "bytes" to bytes)
    } catch (_: BodyLimitExceeded) {
      call.cancel()
      failure("size")
    } catch (_: IOException) {
      call.cancel()
      failure("response")
    }
  }

  private fun knownLength(response: Response): Long {
    val headers = (response.networkResponse ?: response).headers
    if (headers.values("Transfer-Encoding").isNotEmpty()) throw IOException()
    val values = headers.values("Content-Length")
    if (response.code == 204) {
      if (values.isNotEmpty()) throw IOException()
      return 0
    }
    val value = values.singleOrNull() ?: throw IOException()
    if (value.isEmpty() || value.any { it !in '0'..'9' }) throw IOException()
    return value.toLongOrNull() ?: throw IOException()
  }
}
