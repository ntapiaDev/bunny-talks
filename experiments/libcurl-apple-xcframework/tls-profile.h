#ifndef BUNNY_APPLE_TLS_PROFILE_H
#define BUNNY_APPLE_TLS_PROFILE_H

#include <curl/curl.h>

// Apply once to a fresh, unshared easy handle before any transfer.
#ifdef BUNNY_QUALIFICATION_CA
static inline CURLcode bunny_apply_tls_profile(CURL *easy, const char *fixture_ca)
#else
static inline CURLcode bunny_apply_tls_profile(CURL *easy)
#endif
{
#define BUNNY_SETOPT(option, value) do { \
  CURLcode result = curl_easy_setopt(easy, (option), (value)); \
  if (result != CURLE_OK) return result; \
} while (0)

#ifdef BUNNY_QUALIFICATION_CA
  if (!fixture_ca || !*fixture_ca) return CURLE_BAD_FUNCTION_ARGUMENT;
  BUNNY_SETOPT(CURLOPT_CAINFO, fixture_ca);
  BUNNY_SETOPT(CURLOPT_SSL_OPTIONS, 0L);
#else
  BUNNY_SETOPT(CURLOPT_SSL_OPTIONS, (long)CURLSSLOPT_NATIVE_CA);
#endif
  BUNNY_SETOPT(CURLOPT_SSL_VERIFYPEER, 1L);
  BUNNY_SETOPT(CURLOPT_SSL_VERIFYHOST, 2L);
  BUNNY_SETOPT(CURLOPT_SSLVERSION, (long)(CURL_SSLVERSION_TLSv1_2 | CURL_SSLVERSION_MAX_TLSv1_3));
  BUNNY_SETOPT(CURLOPT_SSL_SESSIONID_CACHE, 0L);
  BUNNY_SETOPT(CURLOPT_PROTOCOLS_STR, "https");
  BUNNY_SETOPT(CURLOPT_HTTP_VERSION, (long)CURL_HTTP_VERSION_1_1);
  BUNNY_SETOPT(CURLOPT_PROXY, "");
  BUNNY_SETOPT(CURLOPT_NETRC, (long)CURL_NETRC_IGNORED);
  BUNNY_SETOPT(CURLOPT_FOLLOWLOCATION, 0L);
  BUNNY_SETOPT(CURLOPT_HTTPAUTH, (long)CURLAUTH_NONE);
#undef BUNNY_SETOPT
  return CURLE_OK;
}

#endif
