package fr.bunnytalks.applicationhttps

import okio.Buffer
import okio.GzipSource
import okio.buffer
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.util.zip.GZIPOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BoundedBodyReaderTest {
  @Test fun preservesBytesAtExactLimitAndWithSpareCapacity() {
    val bytes = "Bonjour 🐰 日本語 العربية".toByteArray()
    assertArrayEquals(bytes, BoundedBodyReader.read(ByteArrayInputStream(bytes), bytes.size, -1))
    assertArrayEquals(bytes, BoundedBodyReader.read(ByteArrayInputStream(bytes), 1024, bytes.size.toLong()))
    assertArrayEquals(ByteArray(0), BoundedBodyReader.read(ByteArrayInputStream(ByteArray(0)), 1024, 0))
  }

  @Test fun stopsAfterTheFirstByteOverTheLimit() {
    var consumed = 0
    val stream = object : InputStream() {
      override fun read(): Int { consumed++; return 120 }
    }
    assertThrows(BodyLimitExceeded::class.java) { BoundedBodyReader.read(stream, 32, -1) }
    assertEquals(33, consumed)
  }

  @Test fun rejectsPrematureEndEvenAfterValidJson() {
    assertThrows(EOFException::class.java) {
      BoundedBodyReader.read(ByteArrayInputStream("{}".toByteArray()), 32, 3)
    }
  }

  @Test fun validatesGzipTrailerAndBoundsDecodedBytes() {
    val plain = ByteArray(1024) { 120 }
    val compressed = ByteArrayOutputStream().also { out ->
      GZIPOutputStream(out).use { it.write(plain) }
    }.toByteArray()
    fun read(bytes: ByteArray, limit: Int) = GzipSource(Buffer().write(bytes))
      .buffer().inputStream().use { BoundedBodyReader.read(it, limit, -1) }

    assertArrayEquals(plain, read(compressed, plain.size))
    assertThrows(BodyLimitExceeded::class.java) { read(compressed, plain.size - 1) }
    assertThrows(IOException::class.java) { read(compressed.copyOf(compressed.size - 4), plain.size) }
  }
}
