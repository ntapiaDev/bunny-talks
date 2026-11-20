package fr.bunnytalks.applicationhttps

import java.io.EOFException
import java.io.IOException
import java.io.InputStream

internal const val MAX_RESPONSE_BYTES = 1_048_576

internal class BodyLimitExceeded : IOException()

internal object BoundedBodyReader {
  fun read(stream: InputStream, limit: Int, expectedLength: Long): ByteArray {
    require(limit in 1..MAX_RESPONSE_BYTES)
    if (expectedLength > limit) throw BodyLimitExceeded()
    val capacity = if (expectedLength >= 0) expectedLength.toInt() else limit
    val bytes = ByteArray(capacity)
    var size = 0
    while (size < capacity) {
      val count = stream.read(bytes, size, capacity - size)
      if (count == -1) {
        if (expectedLength >= 0) throw EOFException()
        return bytes.copyOf(size)
      }
      if (count == 0) throw IOException()
      size += count
    }
    if (stream.read() != -1) {
      if (size == limit) throw BodyLimitExceeded()
      throw IOException()
    }
    return bytes
  }
}
