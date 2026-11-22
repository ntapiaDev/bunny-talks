// Local tests of the real response callbacks. No network or Apple runtime.
#include <curl/curl.h>
#include <assert.h>

static CURLMcode cancel_during_perform(CURLM *, int *);
static CURLMcode record_remove(CURLM *, CURL *);
static void record_easy_cleanup(CURL *);
static CURLMcode record_multi_cleanup(CURLM *);
#define curl_multi_perform cancel_during_perform
#define curl_multi_remove_handle record_remove
#define curl_easy_cleanup record_easy_cleanup
#define curl_multi_cleanup record_multi_cleanup
#include "../../modules/application-https/ios/Native/BunnyHttpsNative.c"
#undef curl_multi_perform
#undef curl_multi_remove_handle
#undef curl_easy_cleanup
#undef curl_multi_cleanup

static BunnyHttpsRequest *performing;
static unsigned cleanup_step;

static CURLMcode cancel_during_perform(CURLM *multi, int *running)
{
  assert(performing && performing->multi == multi);
  bunny_https_cancel(performing);
  *running = 0;
  return CURLM_OK;
}

static CURLMcode record_remove(CURLM *multi, CURL *easy)
{
  assert(cleanup_step++ == 0);
  return curl_multi_remove_handle(multi, easy);
}

static void record_easy_cleanup(CURL *easy)
{
  assert(cleanup_step++ == 1);
  curl_easy_cleanup(easy);
}

static CURLMcode record_multi_cleanup(CURLM *multi)
{
  assert(performing && !performing->multi && cleanup_step++ == 2);
  // Cancellation during teardown must no longer wake the retired multi.
  bunny_https_cancel(performing);
  return curl_multi_cleanup(multi);
}

static void check_cancel_cleanup(void)
{
  assert(curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK);
  BunnyHttpsRequest *request = calloc(1, sizeof(*request));
  assert(request && pthread_mutex_init(&request->wakeup_lock, NULL) == 0);
  atomic_init(&request->cancelled, false);
  request->multi = curl_multi_init();
  assert(request->multi);
  struct timespec now;
  assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
  const uint64_t deadline = ((uint64_t)now.tv_sec + 5) * 1000000000 + (uint64_t)now.tv_nsec;
  performing = request;
  BunnyHttpsResult result = bunny_https_perform(request, "https://localhost/", "GET", NULL, 0, 2, deadline);
  assert(atomic_load(&request->cancelled));
  assert(result.outcome == BunnyHttpsNetwork && !result.bytes && !result.size);
  assert(cleanup_step == 3 && !request->multi);
  bunny_https_cancel(request);
  bunny_https_destroy(request);
  performing = NULL;
  curl_global_cleanup();
}

static void reset(struct response *state, BunnyHttpsRequest *request, size_t limit)
{
  if (state->inflater_initialized) inflateEnd(&state->inflater);
  free(state->bytes);
  *state = (struct response){ .request = request, .deadline = UINT64_MAX, .limit = limit };
  atomic_store(&request->cancelled, false);
  assert(before_request(state, NULL, NULL, 0, 0) == CURL_PREREQFUNC_OK);
}

static void field(struct response *state, char *line, bool accepted)
{
  assert((receive_header(line, 1, strlen(line), state) != 0) == accepted);
}

static void gzip_headers(struct response *state)
{
  field(state, "HTTP/1.1 200 OK\r\n", true);
  field(state, "Transfer-Encoding: chunked\r\n", true);
  field(state, "Content-Encoding: gzip\r\n", true);
  field(state, "\r\n", true);
}

static void check_bearer_authorization(void)
{
  assert(bunny_https_is_bearer_authorization("Bearer a"));
  assert(bunny_https_is_bearer_authorization("Bearer Ab9._~-"));
  const char *invalid[] = {
    NULL, "", "Basic fixture", "Digest fixture", "bearer fixture", "Bearer",
    "Bearer ", "Bearer  fixture", "Bearer fixture ", "Bearer\tfixture",
    "Bearer fi/xture", "Bearer fi+xture", "Bearer fixture=", "Bearer fi\xc3\xa9",
    "Bearer fixture\r", "Bearer fixture\n", "Bearer fixture\r\nAccept: x"
  };
  for (size_t i = 0; i < sizeof(invalid) / sizeof(*invalid); ++i)
    assert(!bunny_https_is_bearer_authorization(invalid[i]));

  char longest[7 + 513 + 1] = "Bearer ";
  memset(longest + 7, 'x', 513);
  assert(!bunny_https_is_bearer_authorization(longest));
  longest[7 + 512] = '\0';
  assert(bunny_https_is_bearer_authorization(longest));
}

int main(void)
{
  check_cancel_cleanup();
  check_bearer_authorization();
  BunnyHttpsRequest request;
  atomic_init(&request.cancelled, false);
  struct response state = {0};

  reset(&state, &request, 2);
  assert(before_request(&state, NULL, NULL, 0, 0) == CURL_PREREQFUNC_ABORT);
  field(&state, "HTTP/1.1 103 Early Hints\r\n", true);
  field(&state, "\r\n", true);
  field(&state, "HTTP/1.1 200 OK\r\n", true);
  field(&state, "Content-Length: 2\r\n", true);
  field(&state, "\r\n", true);
  assert(receive_body("{", 1, 1, &state) == 1 && !complete(&state));
  assert(receive_body("}", 1, 1, &state) == 1 && complete(&state));

  reset(&state, &request, 2);
  field(&state, "HTTP/1.1 200 OK\r\n", true);
  field(&state, "Content-Length: 2\r\n", true);
  field(&state, "Transfer-Encoding: chunked\r\n", true);
  field(&state, "\r\n", false);
  assert(state.outcome == BunnyHttpsResponse);

  reset(&state, &request, 2);
  field(&state, "HTTP/1.1 200 OK\r\n", true);
  field(&state, "\r\n", false);
  assert(state.outcome == BunnyHttpsResponse);

  reset(&state, &request, 2);
  field(&state, "HTTP/1.1 200 OK\r\n", true);
  field(&state, "Content-Length: 3\r\n", true);
  field(&state, "\r\n", false);
  assert(state.outcome == BunnyHttpsSize);

  reset(&state, &request, 2);
  field(&state, "HTTP/1.1 200 OK\r\n", true);
  field(&state, "Content-Length: 2\r\n", true);
  field(&state, "Content-Length: 2\r\n", false);
  assert(state.outcome == BunnyHttpsResponse);

  reset(&state, &request, 8);
  field(&state, "HTTP/1.1 200 OK\r\n", true);
  field(&state, "Content-Length: 2\r\n", true);
  field(&state, "Content-Length: 3\r\n", false);
  apply_completion(&state, CURLE_WRITE_ERROR);
  assert(state.outcome == BunnyHttpsResponse && !complete(&state) && state.used == 0);

  reset(&state, &request, 8);
  field(&state, "HTTP/1.1 200 OK\r\n", true);
  field(&state, "Content-Length: 2\r\n", true);
  // The pinned curl parser may return this before calling receive_header again.
  apply_completion(&state, CURLE_WEIRD_SERVER_REPLY);
  assert(state.outcome == BunnyHttpsResponse && !complete(&state) && state.bytes == NULL);
#ifdef BUNNY_HTTPS_QUALIFICATION
  assert(strcmp(qualification_completion(CURLE_WEIRD_SERVER_REPLY, state.headers_complete),
                "weird-reply-before-headers") == 0);
#endif

  reset(&state, &request, 8);
  field(&state, "HTTP/1.1 200 OK\r\n", true);
  field(&state, "Content-Length: 2\r\n", true);
  apply_completion(&state, CURLE_RECV_ERROR);
  assert(state.outcome == BunnyHttpsNetwork && !complete(&state) && state.bytes == NULL);
  reset(&state, &request, 8);
  apply_completion(&state, CURLE_WEIRD_SERVER_REPLY);
  assert(state.outcome == BunnyHttpsNetwork && !complete(&state));

  reset(&state, &request, 2);
  field(&state, "HTTP/1.1 204 No Content\r\n", true);
  field(&state, "\r\n", true);
  assert(complete(&state));
  assert(receive_body("x", 1, 1, &state) == 0 && state.outcome == BunnyHttpsResponse);

  reset(&state, &request, 2);
  field(&state, "HTTP/1.1 302 Found\r\n", true);
  field(&state, "\r\n", false);
  assert(state.outcome == BunnyHttpsRedirect);

  unsigned char gzip[128];
  z_stream encoder = {0};
  assert(deflateInit2(&encoder, Z_DEFAULT_COMPRESSION, Z_DEFLATED, MAX_WBITS + 16,
                     8, Z_DEFAULT_STRATEGY) == Z_OK);
  encoder.next_in = (unsigned char *)"{}";
  encoder.avail_in = 2;
  encoder.next_out = gzip;
  encoder.avail_out = sizeof(gzip);
  assert(deflate(&encoder, Z_FINISH) == Z_STREAM_END);
  const size_t length = encoder.total_out;
  assert(deflateEnd(&encoder) == Z_OK);

  reset(&state, &request, 2);
  gzip_headers(&state);
  for (size_t i = 0; i < length; ++i)
    assert(receive_body((char *)gzip + i, 1, 1, &state) == 1);
  assert(complete(&state) && state.used == 2 && memcmp(state.bytes, "{}", 2) == 0);
  assert(receive_body("x", 1, 1, &state) == 0 && state.outcome == BunnyHttpsResponse);

  reset(&state, &request, 2);
  gzip_headers(&state);
  assert(receive_body((char *)gzip, 1, length, &state) == length);
  field(&state, "X-Trailer: unexpected\r\n", false);
  assert(state.outcome == BunnyHttpsResponse);

  reset(&state, &request, 2);
  gzip_headers(&state);
  assert(receive_body((char *)gzip, 1, length - 1, &state) == length - 1);
  assert(!complete(&state));

  reset(&state, &request, 1);
  gzip_headers(&state);
  assert(receive_body((char *)gzip, 1, length, &state) == 0 && state.outcome == BunnyHttpsSize);

  reset(&state, &request, 2);
  gzip_headers(&state);
  gzip[length - 8] ^= 1;
  assert(receive_body((char *)gzip, 1, length, &state) == 0 && state.outcome == BunnyHttpsResponse);

  reset(&state, &request, 2);
  atomic_store(&request.cancelled, true);
  assert(before_request(&state, NULL, NULL, 0, 0) == CURL_PREREQFUNC_ABORT);
  state.deadline = 0;
  assert(stopped(&state) && state.outcome == BunnyHttpsTimeout);
  reset(&state, &request, 2);
  return 0;
}
