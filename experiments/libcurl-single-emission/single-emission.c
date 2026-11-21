#include <curl/curl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define CURL_VERSION_8_23_0 0x081700
#if LIBCURL_VERSION_NUM != CURL_VERSION_8_23_0
#error This experiment requires libcurl 8.23.0 headers.
#endif

#define REQUIRE_CURL(call)                                                     \
  do {                                                                        \
    CURLcode result = (call);                                                  \
    if (result != CURLE_OK) {                                                  \
      fprintf(stderr, "%s failed (%d)\n", #call, (int)result);                \
      exit(EXIT_FAILURE);                                                     \
    }                                                                         \
  } while (0)

struct attempt {
  curl_off_t connection_id;
  long new_connections;
  bool allowed;
};

struct transfer {
  CURL *easy;
  bool guard_enabled;
  int prereq_calls;
  struct attempt attempts[2];
  size_t body_bytes;
  bool body_matches;
  int retry_after_count;
  bool retry_after_zero;
};

static int before_request(void *user_data, char *remote_ip, char *local_ip,
                          int remote_port, int local_port)
{
  (void)remote_ip;
  (void)local_ip;
  (void)remote_port;
  (void)local_port;
  struct transfer *transfer = user_data;
  int index = transfer->prereq_calls++;
  bool allowed = !transfer->guard_enabled || index == 0;

  if (index < 2) {
    struct attempt *attempt = &transfer->attempts[index];
    attempt->allowed = allowed;
    REQUIRE_CURL(curl_easy_getinfo(transfer->easy, CURLINFO_CONN_ID,
                                  &attempt->connection_id));
    REQUIRE_CURL(curl_easy_getinfo(transfer->easy, CURLINFO_NUM_CONNECTS,
                                  &attempt->new_connections));
  }
  return allowed ? CURL_PREREQFUNC_OK : CURL_PREREQFUNC_ABORT;
}

static size_t observe_body(char *bytes, size_t size, size_t count, void *user_data)
{
  static const char expected[] = "{}";
  struct transfer *transfer = user_data;
  size_t length = size * count;
  if (transfer->body_matches) {
    transfer->body_matches =
        length <= sizeof(expected) - 1 - transfer->body_bytes &&
        memcmp(bytes, expected + transfer->body_bytes, length) == 0;
  }
  transfer->body_bytes += length;
  return length;
}

static size_t observe_header(char *bytes, size_t size, size_t count, void *user_data)
{
  static const char name[] = "Retry-After:";
  static const char zero[] = " 0\r\n";
  struct transfer *transfer = user_data;
  size_t length = size * count;
  if (length >= sizeof(name) - 1 &&
      strncasecmp(bytes, name, sizeof(name) - 1) == 0) {
    transfer->retry_after_count++;
    transfer->retry_after_zero =
        length == sizeof(name) + sizeof(zero) - 2 &&
        memcmp(bytes + sizeof(name) - 1, zero, sizeof(zero) - 1) == 0;
  }
  return length;
}

static void perform(CURL *easy, const char *label, long port, const char *route,
                    bool guard_enabled)
{
  struct transfer transfer = {
    .easy = easy, .guard_enabled = guard_enabled, .body_matches = true
  };
  char url[128];
  int length = snprintf(url, sizeof(url), "https://127.0.0.1:%ld/%s", port, route);
  if (length < 0 || (size_t)length >= sizeof(url))
    exit(EXIT_FAILURE);

  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_URL, url));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_PREREQDATA, &transfer));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_WRITEDATA, &transfer));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_HEADERDATA, &transfer));
  CURLcode result = curl_easy_perform(easy);

  long status, http_version, new_connections, verify_result;
  curl_off_t connection_id, content_length, early_data;
  REQUIRE_CURL(curl_easy_getinfo(easy, CURLINFO_RESPONSE_CODE, &status));
  REQUIRE_CURL(curl_easy_getinfo(easy, CURLINFO_HTTP_VERSION, &http_version));
  REQUIRE_CURL(curl_easy_getinfo(easy, CURLINFO_CONN_ID, &connection_id));
  REQUIRE_CURL(curl_easy_getinfo(easy, CURLINFO_NUM_CONNECTS, &new_connections));
  REQUIRE_CURL(curl_easy_getinfo(easy, CURLINFO_CONTENT_LENGTH_DOWNLOAD_T, &content_length));
  REQUIRE_CURL(curl_easy_getinfo(easy, CURLINFO_SSL_VERIFYRESULT, &verify_result));
  REQUIRE_CURL(curl_easy_getinfo(easy, CURLINFO_EARLYDATA_SENT_T, &early_data));

  printf("\"%s\":{\"code\":%d,\"status\":%ld,\"http11\":%s,"
         "\"connectionId\":%" CURL_FORMAT_CURL_OFF_T ",\"newConnections\":%ld,"
         "\"contentLength\":%" CURL_FORMAT_CURL_OFF_T ",\"verifyResult\":%ld,"
         "\"earlyDataBytes\":%" CURL_FORMAT_CURL_OFF_T ",\"bodyBytes\":%zu,"
         "\"expectedBody\":%s,\"retryAfterZero\":%s,\"prereqCalls\":%d,\"attempts\":[",
         label, (int)result, status, http_version == CURL_HTTP_VERSION_1_1 ? "true" : "false",
         connection_id, new_connections, content_length, verify_result, early_data,
         transfer.body_bytes, transfer.body_bytes == 2 && transfer.body_matches ? "true" : "false",
         transfer.retry_after_count == 1 && transfer.retry_after_zero ? "true" : "false",
         transfer.prereq_calls);
  for (int index = 0; index < transfer.prereq_calls && index < 2; ++index) {
    const struct attempt *attempt = &transfer.attempts[index];
    printf("%s{\"connectionId\":%" CURL_FORMAT_CURL_OFF_T ",\"newConnections\":%ld,"
           "\"allowed\":%s}", index == 0 ? "" : ",", attempt->connection_id,
           attempt->new_connections, attempt->allowed ? "true" : "false");
  }
  printf("]}");
}

static CURL *new_handle(const char *ca_file)
{
  CURL *easy = curl_easy_init();
  if (!easy)
    exit(EXIT_FAILURE);

  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_PROTOCOLS_STR, "https"));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_HTTP_VERSION, (long)CURL_HTTP_VERSION_1_1));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_HTTPGET, 1L));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_PROXY, ""));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_FOLLOWLOCATION, 0L));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_NETRC, (long)CURL_NETRC_IGNORED));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_HTTPAUTH, (long)CURLAUTH_NONE));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_FAILONERROR, 0L));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_CAINFO, ca_file));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_SSL_VERIFYPEER, 1L));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_SSL_VERIFYHOST, 2L));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_SSL_OPTIONS, 0L));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_TIMEOUT_MS, 4000L));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_PREREQFUNCTION, before_request));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, observe_body));
  REQUIRE_CURL(curl_easy_setopt(easy, CURLOPT_HEADERFUNCTION, observe_header));
  return easy;
}

int main(int argc, char **argv)
{
  if (argc != 4) {
    fputs("Usage: single-emission witness|candidate|tls-control PORT CA_PEM\n", stderr);
    return EXIT_FAILURE;
  }
  bool candidate = strcmp(argv[1], "candidate") == 0;
  bool tls_control = strcmp(argv[1], "tls-control") == 0;
  char *end;
  long port = strtol(argv[2], &end, 10);
  if ((!candidate && !tls_control && strcmp(argv[1], "witness") != 0) ||
      *end || port < 1024 || port > 65529)
    return EXIT_FAILURE;

  REQUIRE_CURL(curl_global_init(CURL_GLOBAL_DEFAULT));
  const curl_version_info_data *version = curl_version_info(CURLVERSION_NOW);
  if (version->version_num != CURL_VERSION_8_23_0 || !version->ssl_version ||
      (version->features & (CURL_VERSION_HTTP2 | CURL_VERSION_HTTP3))) {
    fputs("Expected TLS-enabled libcurl 8.23.0 without HTTP/2 or HTTP/3\n", stderr);
    return EXIT_FAILURE;
  }
  printf("{\"libcurl\":\"%s\",\"tlsBackend\":\"%s\",", version->version, version->ssl_version);
  CURL *easy = new_handle(argv[3]);
  if (tls_control) {
    perform(easy, "unknownCa", port + 3, "retry-status-length", false);
    printf(",");
    perform(easy, "wrongName", port + 4, "retry-status-length", false);
  }
  else {
    perform(easy, "prime", port, "retry-status-length", false);
    printf(",");
    perform(easy, "drop", port, "drop-before-headers", candidate);
  }
  curl_easy_cleanup(easy);
  curl_global_cleanup();
  puts("}");
  return EXIT_SUCCESS;
}
