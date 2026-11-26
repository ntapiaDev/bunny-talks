#include "BunnyHttpsNative.h"
#include <curl/curl.h>
#include <limits.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <zlib.h>

#if LIBCURL_VERSION_NUM != 0x081700
#error Expected pinned libcurl 8.23.0 headers
#endif

struct BunnyHttpsRequest {
  CURLM *multi;
  pthread_mutex_t wakeup_lock;
  struct curl_slist *headers;
  atomic_bool cancelled;
};

struct response {
  BunnyHttpsRequest *request;
  uint64_t deadline;
  bool attempted;
  bool headers_complete;
  bool chunked;
  bool has_length;
  bool has_coding;
  bool gzip;
  bool stream_end;
  bool inflater_initialized;
  int status;
  size_t length;
  size_t received;
  size_t limit;
  size_t used;
  size_t capacity;
  unsigned char *bytes;
  char content_type[256];
  z_stream inflater;
  BunnyHttpsOutcome outcome;
};

static pthread_once_t curl_once = PTHREAD_ONCE_INIT;
static bool curl_ready;

static void initialize_curl(void)
{
  curl_ready = curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK;
}

const char *bunny_https_runtime_profile(void)
{
  pthread_once(&curl_once, initialize_curl);
  if (!curl_ready) return NULL;
  const curl_version_info_data *info = curl_version_info(CURLVERSION_NOW);
  if (info->version_num != LIBCURL_VERSION_NUM || !info->ssl_version ||
      strcmp(info->ssl_version, "OpenSSL/3.5.9") != 0 || !info->feature_names ||
      !(info->features & CURL_VERSION_ASYNCHDNS) ||
      (info->features & (CURL_VERSION_HTTP2 | CURL_VERSION_HTTP3 | CURL_VERSION_LIBZ)))
    return NULL;
  for (const char *const *name = info->feature_names; *name; ++name) {
    if (strcmp(*name, "AppleSecTrust") == 0)
      return "libcurl/8.23.0 OpenSSL/3.5.9 AppleSecTrust AsynchDNS HTTP/1.1 system-zlib";
  }
  return NULL;
}

BunnyHttpsRequest *bunny_https_create(void)
{
  if (!bunny_https_runtime_profile()) return NULL;
  BunnyHttpsRequest *request = calloc(1, sizeof(*request));
  if (!request) return NULL;
  atomic_init(&request->cancelled, false);
  if (pthread_mutex_init(&request->wakeup_lock, NULL) != 0) {
    free(request);
    return NULL;
  }
  request->multi = curl_multi_init();
  if (!request->multi) {
    pthread_mutex_destroy(&request->wakeup_lock);
    free(request);
    return NULL;
  }
  return request;
}

bool bunny_https_add_header(BunnyHttpsRequest *request, const char *header)
{
  struct curl_slist *added = curl_slist_append(request->headers, header);
  if (!added) return false;
  request->headers = added;
  return true;
}

bool bunny_https_is_bearer_authorization(const char *value)
{
  const char prefix[] = "Bearer ";
  if (!value || strncmp(value, prefix, sizeof(prefix) - 1) != 0) return false;
  const char *token = value + sizeof(prefix) - 1;
  // Keep the alphabet and length aligned with application-http.ts.
  const size_t length = strspn(token, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-");
  return length >= 1 && length <= 512 && token[length] == '\0';
}

void bunny_https_cancel(BunnyHttpsRequest *request)
{
  atomic_store(&request->cancelled, true);
  pthread_mutex_lock(&request->wakeup_lock);
  if (request->multi) curl_multi_wakeup(request->multi);
  pthread_mutex_unlock(&request->wakeup_lock);
}

static void close_multi(BunnyHttpsRequest *request)
{
  // Stop new wakeups and let any in-progress wakeup finish before cleanup.
  pthread_mutex_lock(&request->wakeup_lock);
  CURLM *multi = request->multi;
  request->multi = NULL;
  pthread_mutex_unlock(&request->wakeup_lock);
  if (multi) curl_multi_cleanup(multi);
}

void bunny_https_destroy(BunnyHttpsRequest *request)
{
  close_multi(request);
  pthread_mutex_destroy(&request->wakeup_lock);
  curl_slist_free_all(request->headers);
  free(request);
}

static uint64_t remaining_ns(uint64_t deadline)
{
  // On Darwin CLOCK_UPTIME_RAW uses the same uptime clock as DispatchTime.
#ifdef __APPLE__
  const clockid_t clock = CLOCK_UPTIME_RAW;
#else
  const clockid_t clock = CLOCK_MONOTONIC;
#endif
  struct timespec now;
  if (clock_gettime(clock, &now) != 0) return 0;
  const uint64_t current = (uint64_t)now.tv_sec * 1000000000 + (uint64_t)now.tv_nsec;
  return current < deadline ? deadline - current : 0;
}

static bool stopped(struct response *state)
{
  if (!remaining_ns(state->deadline)) {
    state->outcome = BunnyHttpsTimeout;
    return true;
  }
  if (atomic_load(&state->request->cancelled)) {
    state->outcome = BunnyHttpsNetwork;
    return true;
  }
  return false;
}

static int before_request(void *context, char *remote, char *local, int remote_port, int local_port)
{
  (void)remote; (void)local; (void)remote_port; (void)local_port;
  struct response *state = context;
  if (stopped(state) || state->attempted) return CURL_PREREQFUNC_ABORT;
  state->attempted = true;
  return CURL_PREREQFUNC_OK;
}

static int progress(void *context, curl_off_t download_size, curl_off_t downloaded,
                    curl_off_t upload_size, curl_off_t uploaded)
{
  (void)download_size; (void)downloaded; (void)upload_size; (void)uploaded;
  return stopped(context) ? 1 : 0;
}

static bool field_is(const char *start, const char *end, const char *expected)
{
  return (size_t)(end - start) == strlen(expected) &&
         strncasecmp(start, expected, (size_t)(end - start)) == 0;
}

static bool parse_length(struct response *state, const char *start, const char *end)
{
  if (state->has_length || start == end) return false;
  size_t length = 0;
  for (const char *p = start; p < end; ++p) {
    if (*p < '0' || *p > '9') return false;
    const size_t digit = (size_t)(*p - '0');
    if (length > (SIZE_MAX - digit) / 10) return false;
    length = length * 10 + digit;
  }
  state->has_length = true;
  state->length = length;
  return true;
}

static bool header_name_char(unsigned char c)
{
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
         (c >= '0' && c <= '9') || (c != 0 && strchr("!#$%&'*+-.^`_|~", c));
}

static bool parse_field(struct response *state, const char *line, const char *end)
{
  const char *colon = memchr(line, ':', (size_t)(end - line));
  if (!colon || colon == line) return false;
  for (const char *p = line; p < colon; ++p)
    if (!header_name_char((unsigned char)*p)) return false;
  const char *value = colon + 1;
  while (value < end && (*value == ' ' || *value == '\t')) ++value;
  while (end > value && (end[-1] == ' ' || end[-1] == '\t')) --end;
  for (const char *p = value; p < end; ++p) {
    const unsigned char c = (unsigned char)*p;
    if ((c < 32 && c != '\t') || c == 127) return false;
  }
  if (field_is(line, colon, "Content-Length")) return parse_length(state, value, end);
  if (field_is(line, colon, "Transfer-Encoding")) {
    if (state->chunked || !field_is(value, end, "chunked")) return false;
    state->chunked = true;
  } else if (field_is(line, colon, "Content-Encoding")) {
    if (state->has_coding) return false;
    state->has_coding = true;
    state->gzip = field_is(value, end, "gzip");
    if (!state->gzip && !field_is(value, end, "identity")) return false;
  } else if (field_is(line, colon, "Content-Type")) {
    const size_t length = (size_t)(end - value);
    if (state->content_type[0] || !length || length >= sizeof(state->content_type) ||
        (length >= 25 && strncasecmp(value, "multipart/x-mixed-replace", 25) == 0)) return false;
    for (const char *p = value; p < end; ++p)
      if ((unsigned char)*p > 126) return false;
    memcpy(state->content_type, value, length);
    state->content_type[length] = 0;
  }
  return true;
}

static bool end_headers(struct response *state)
{
  if (state->status < 200) {
    if (state->status == 101 || state->has_length || state->chunked || state->has_coding) return false;
    state->status = 0;
    state->content_type[0] = 0;
    return true;
  }
  if (state->status < 400 && state->status >= 300) {
    state->outcome = BunnyHttpsRedirect;
    return false;
  }
  if (state->status == 204) {
    if (state->chunked || state->gzip || (state->has_length && state->length != 0)) return false;
  } else if (state->has_length == state->chunked) {
    return false;
  }
  if (!state->gzip && state->has_length && state->length > state->limit) {
    state->outcome = BunnyHttpsSize;
    return false;
  }
  state->headers_complete = true;
  return true;
}

static size_t receive_header(char *line, size_t size, size_t count, void *context)
{
  struct response *state = context;
  const size_t length = size * count;
  if (stopped(state)) return 0;
  // Trailers are outside the supported response contract.
  if (state->headers_complete || length < 2 || memcmp(line + length - 2, "\r\n", 2) != 0)
    goto invalid;
  if (!state->status) {
    if (length < 14 || memcmp(line, "HTTP/1.1 ", 9) != 0 ||
        line[9] < '1' || line[9] > '5' || line[10] < '0' || line[10] > '9' ||
        line[11] < '0' || line[11] > '9' || (length > 14 && line[12] != ' '))
      goto invalid;
    for (size_t index = 13; index < length - 2; ++index) {
      unsigned char character = (unsigned char)line[index];
      if ((character < 32 && character != '\t') || character == 127) goto invalid;
    }
    state->status = (line[9] - '0') * 100 + (line[10] - '0') * 10 + line[11] - '0';
  } else if (!(length == 2 ? end_headers(state) : parse_field(state, line, line + length - 2))) {
    goto invalid;
  }
  return length;

invalid:
  if (state->outcome == BunnyHttpsNetwork) state->outcome = BunnyHttpsResponse;
  return 0;
}

static bool reserve_bytes(struct response *state, size_t additional)
{
  if (additional > state->limit - state->used) {
    state->outcome = BunnyHttpsSize;
    return false;
  }
  const size_t needed = state->used + additional;
  if (needed <= state->capacity) return true;
  size_t capacity = state->capacity ? state->capacity * 2 : 4096;
  if (capacity < needed) capacity = needed;
  if (capacity > state->limit) capacity = state->limit;
  unsigned char *bytes = realloc(state->bytes, capacity);
  if (!bytes) return false;
  state->bytes = bytes;
  state->capacity = capacity;
  return true;
}

static bool decode_gzip(struct response *state, unsigned char *bytes, size_t length)
{
  if (state->stream_end || length > UINT_MAX) return false;
  z_stream *stream = &state->inflater;
  if (!state->inflater_initialized) {
    if (inflateInit2(stream, MAX_WBITS + 16) != Z_OK) return false;
    state->inflater_initialized = true;
  }
  stream->next_in = bytes;
  stream->avail_in = (uInt)length;
  do {
    if (stopped(state)) return false;
    const bool full = state->used == state->limit;
    unsigned char overflow;
    if (!full && state->capacity == state->used && !reserve_bytes(state, 1)) return false;
    stream->next_out = full ? &overflow : state->bytes + state->used;
    const uInt space = full ? 1 : (uInt)(state->capacity - state->used);
    stream->avail_out = space;
    const uInt previous_input = stream->avail_in;
    int result = inflate(stream, Z_NO_FLUSH);
    const size_t produced = space - stream->avail_out;
    if (full && produced) {
      state->outcome = BunnyHttpsSize;
      return false;
    }
    state->used += produced;
    if (result == Z_STREAM_END) {
      state->stream_end = true;
      return stream->avail_in == 0;
    }
    if (result == Z_BUF_ERROR && stream->avail_in == 0) return true;
    if (result != Z_OK || (!produced && previous_input == stream->avail_in)) return false;
  } while (stream->avail_in || stream->avail_out == 0);
  return true;
}

static size_t receive_body(char *bytes, size_t size, size_t count, void *context)
{
  struct response *state = context;
  const size_t length = size * count;
  if (stopped(state)) return 0;
  if (!length) return 0;
  if (!state->headers_complete || state->status == 204 ||
      length > SIZE_MAX - state->received ||
      (state->has_length && length > state->length - state->received))
    goto invalid;
  state->received += length;
  if (state->gzip) {
    if (!decode_gzip(state, (unsigned char *)bytes, length)) {
      if (stopped(state) || state->outcome == BunnyHttpsSize) return 0;
      goto invalid;
    }
  } else {
    if (!reserve_bytes(state, length)) return 0;
    memcpy(state->bytes + state->used, bytes, length);
    state->used += length;
  }
  return length;

invalid:
  state->outcome = BunnyHttpsResponse;
  return 0;
}

static bool complete(const struct response *state)
{
  return state->headers_complete && state->attempted &&
         (!state->has_length || state->received == state->length) &&
         (!state->gzip || state->stream_end);
}

static void apply_completion(struct response *state, CURLcode code)
{
  if (code == CURLE_OPERATION_TIMEDOUT) {
    state->outcome = BunnyHttpsTimeout;
  } else if (code == CURLE_OK && complete(state)) {
    state->outcome = BunnyHttpsSuccess;
  } else if (state->outcome == BunnyHttpsNetwork &&
             (state->headers_complete || (state->status >= 200 && code == CURLE_WEIRD_SERVER_REPLY))) {
    // curl can reject an invalid final header before handing it to receive_header.
    state->outcome = BunnyHttpsResponse;
  }
}

#ifdef BUNNY_HTTPS_QUALIFICATION
static const char *qualification_completion(CURLcode code, bool headers_complete)
{
  switch (code) {
    case CURLE_WEIRD_SERVER_REPLY:
      return headers_complete ? "weird-reply-after-headers" : "weird-reply-before-headers";
    case CURLE_WRITE_ERROR: return "write-error";
    case CURLE_RECV_ERROR: return "receive-error";
    case CURLE_PARTIAL_FILE: return "partial-file";
    case CURLE_OPERATION_TIMEDOUT: return "timeout";
    case CURLE_OK: return "ok";
    default: return "other";
  }
}
#endif

BunnyHttpsResult bunny_https_perform(BunnyHttpsRequest *request, const char *url, const char *method,
                                    const void *body, size_t body_size, size_t limit,
                                    uint64_t deadline_ns)
{
  BunnyHttpsResult result = { .outcome = BunnyHttpsNetwork };
#ifdef BUNNY_HTTPS_QUALIFICATION
  result.qualification_completion = "not-completed";
#endif
  CURLM *multi = request->multi;
  if (!multi) return result;
  struct response state = { .request = request, .deadline = deadline_ns, .limit = limit };
  CURL *easy = NULL;
  bool added = false;
  if (!limit || limit > 1048576) goto finish;
  if (stopped(&state)) goto finish;
  easy = curl_easy_init();
  if (!easy) goto finish;
  const long timeout_ms = (long)((remaining_ns(deadline_ns) + 999999) / 1000000);
  if (!timeout_ms) {
    state.outcome = BunnyHttpsTimeout;
    goto finish;
  }

#define SET(option, value) do { if (curl_easy_setopt(easy, option, value) != CURLE_OK) goto finish; } while (0)
  SET(CURLOPT_URL, url);
  SET(CURLOPT_PROTOCOLS_STR, "https");
  SET(CURLOPT_HTTP_VERSION, (long)CURL_HTTP_VERSION_1_1);
  SET(CURLOPT_DISALLOW_USERNAME_IN_URL, 1L);
  SET(CURLOPT_PROXY, "");
  SET(CURLOPT_NETRC, (long)CURL_NETRC_IGNORED);
  SET(CURLOPT_FOLLOWLOCATION, 0L);
  SET(CURLOPT_HTTPAUTH, (long)CURLAUTH_NONE);
  SET(CURLOPT_SSL_VERIFYPEER, 1L);
  SET(CURLOPT_SSL_VERIFYHOST, 2L);
  SET(CURLOPT_SSL_OPTIONS, (long)CURLSSLOPT_NATIVE_CA);
  SET(CURLOPT_SSLVERSION, (long)(CURL_SSLVERSION_TLSv1_2 | CURL_SSLVERSION_MAX_TLSv1_3));
  SET(CURLOPT_SSL_SESSIONID_CACHE, 0L);
  SET(CURLOPT_NOSIGNAL, 1L);
  SET(CURLOPT_TIMEOUT_MS, timeout_ms);
  SET(CURLOPT_FORBID_REUSE, 1L);
  SET(CURLOPT_HTTP_CONTENT_DECODING, 0L);
  SET(CURLOPT_HTTP_TRANSFER_DECODING, 1L);
  SET(CURLOPT_HTTPHEADER, request->headers);
  SET(CURLOPT_PREREQFUNCTION, before_request);
  SET(CURLOPT_PREREQDATA, &state);
  SET(CURLOPT_XFERINFOFUNCTION, progress);
  SET(CURLOPT_XFERINFODATA, &state);
  SET(CURLOPT_NOPROGRESS, 0L);
  SET(CURLOPT_HEADERFUNCTION, receive_header);
  SET(CURLOPT_HEADERDATA, &state);
  SET(CURLOPT_WRITEFUNCTION, receive_body);
  SET(CURLOPT_WRITEDATA, &state);
  if (strcmp(method, "POST") == 0) {
    SET(CURLOPT_POST, 1L);
    SET(CURLOPT_POSTFIELDS, body ? body : "");
    SET(CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)body_size);
  } else if (strcmp(method, "DELETE") == 0) {
    SET(CURLOPT_CUSTOMREQUEST, "DELETE");
  } else if (strcmp(method, "GET") != 0) {
    goto finish;
  }
#undef SET

  if (curl_multi_add_handle(multi, easy) != CURLM_OK) goto finish;
  added = true;
  while (!stopped(&state)) {
    int running;
    if (curl_multi_perform(multi, &running) != CURLM_OK) break;
    int messages;
    CURLMsg *message = curl_multi_info_read(multi, &messages);
    if (message && message->msg == CURLMSG_DONE) {
#ifdef BUNNY_HTTPS_QUALIFICATION
      result.qualification_completion = qualification_completion(message->data.result, state.headers_complete);
#endif
      if (stopped(&state)) break;
      apply_completion(&state, message->data.result);
      break;
    }
    if (!running || curl_multi_poll(multi, NULL, 0, 100, NULL) != CURLM_OK) break;
  }

finish:
  if (added) curl_multi_remove_handle(multi, easy);
  if (easy) curl_easy_cleanup(easy);
  close_multi(request);
  if (state.inflater_initialized) inflateEnd(&state.inflater);
  stopped(&state);
  result.outcome = state.outcome;
  if (state.outcome == BunnyHttpsSuccess) {
    result.status = state.status;
    memcpy(result.content_type, state.content_type, sizeof(result.content_type));
    result.bytes = state.bytes;
    result.size = state.used;
  } else {
    free(state.bytes);
  }
  return result;
}
