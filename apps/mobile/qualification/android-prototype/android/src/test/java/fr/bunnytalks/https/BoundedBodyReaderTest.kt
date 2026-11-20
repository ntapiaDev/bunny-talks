package fr.bunnytalks.https

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BoundedBodyReaderTest {
  @Test fun preservesBytesAndExactLimit() {
    val bytes = "Bonjour 🐰 日本語 العربية".toByteArray(Charsets.UTF_8)
    assertArrayEquals(bytes, BoundedBodyReader.read(ByteArrayInputStream(bytes), bytes.size))
    assertArrayEquals(bytes, BoundedBodyReader.read(ByteArrayInputStream(bytes), 1024))
  }
  @Test fun stopsAtLimitPlusOne() {
    var consumed = 0
    val stream = object : InputStream() { override fun read(): Int { consumed++; return 120 } }
    assertThrows(IOException::class.java) { BoundedBodyReader.read(stream, 32) }
    assertEquals(33, consumed)
  }
  @Test fun propagatesReadFailureAfterValidJsonPrefix() {
    val stream = object : InputStream() {
      var position = 0
      override fun read(): Int { if (position >= 2) throw IOException("truncated"); return "{}"[position++].code }
    }
    assertThrows(IOException::class.java) { BoundedBodyReader.read(stream, 32) }
  }
}
