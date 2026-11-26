package fr.bunnytalks.applicationhttps

import okhttp3.Headers
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpsClientTest {
  private val client = HttpsClient.create()
  private val request = HttpsClient.request("https://example.invalid/v1/session", "GET", emptyMap(), null)

  private fun read(status: Int, headers: Headers, body: String, limit: Int = 16): Map<String, Any?> {
    val response = Response.Builder()
      .request(request)
      .protocol(Protocol.HTTP_1_1)
      .code(status)
      .message("Fixture")
      .headers(headers)
      .body(body.toResponseBody())
      .build()
    return HttpsClient.read(client.newCall(request), response, limit)
  }

  @Test fun usesIdentityEncodingAndAcceptsCompleteKnownLengths() {
    assertEquals("identity", request.header("Accept-Encoding"))
    assertFalse(client.retryOnConnectionFailure)
    val result = read(200, Headers.headersOf("Content-Length", "2"), "{}")
    assertEquals(true, result["ok"])
    assertArrayEquals("{}".toByteArray(), result["bytes"] as ByteArray)
    assertEquals(true, read(204, Headers.headersOf(), "")["ok"])
  }

  @Test fun rejectsCodingAmbiguousFramingAndTruncationWithoutDeliveringBytes() {
    for (headers in listOf(
      Headers.headersOf(),
      Headers.headersOf("Content-Length", "2", "Content-Encoding", "gzip"),
      Headers.headersOf("Content-Length", "2", "Content-Encoding", "identity"),
      Headers.headersOf("Transfer-Encoding", "chunked"),
      Headers.headersOf("Content-Length", "2", "Content-Length", "2"),
      Headers.headersOf("Content-Length", "2", "Transfer-Encoding", "chunked"),
      Headers.headersOf("Content-Length", "3")
    )) {
      assertEquals(failure("response"), read(200, headers, "{}"))
    }
    assertEquals(failure("response"), read(204, Headers.headersOf("Content-Length", "0"), ""))
    assertEquals(failure("size"), read(503, Headers.headersOf("Content-Length", "17"), "{}"))
    assertTrue(read(200, Headers.headersOf("Content-Length", "2"), "{}")["ok"] == true)
  }
}
