package fr.bunnytalks.https

import java.io.IOException
import java.io.InputStream

internal object BoundedBodyReader {
  fun read(stream: InputStream, limit: Int): ByteArray {
    require(limit in 1..1048576)
    val bytes = ByteArray(limit)
    var size = 0
    while (size < limit) {
      val count = stream.read(bytes, size, limit - size)
      if (count == -1) return bytes.copyOf(size)
      if (count == 0) throw IOException("read")
      size += count
    }
    if (stream.read() != -1) throw IOException("size")
    return bytes
  }
}
