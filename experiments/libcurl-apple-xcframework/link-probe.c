#include "tls-profile.h"
#include <openssl/crypto.h>
#include <openssl/opensslv.h>
#include <string.h>

#if LIBCURL_VERSION_NUM != 0x081700 || OPENSSL_VERSION_MAJOR != 3 || \
    OPENSSL_VERSION_MINOR != 5 || OPENSSL_VERSION_PATCH != 9
#error Unexpected curl or OpenSSL headers
#endif

// Linked for each slice and profile. No TLS transfer or Apple runtime test.
int main(int argc, char **argv)
{
  if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) return 1;
  const curl_version_info_data *version = curl_version_info(CURLVERSION_NOW);
  int match = version->version_num == LIBCURL_VERSION_NUM && version->ssl_version &&
              strcmp(version->ssl_version, "OpenSSL/3.5.9") == 0 &&
              OpenSSL_version_num() == OPENSSL_VERSION_NUMBER &&
              !(version->features & (CURL_VERSION_HTTP2 | CURL_VERSION_HTTP3));
  for (const char *const *feature = version->feature_names; match && *feature; ++feature) {
    if (strcmp(*feature, "AppleSecTrust") == 0) {
      CURL *easy = curl_easy_init();
      if (!easy) break;
#ifdef BUNNY_QUALIFICATION_CA
      CURLcode result = bunny_apply_tls_profile(easy, argc == 2 ? argv[1] : NULL);
#else
      (void)argc;
      (void)argv;
      CURLcode result = bunny_apply_tls_profile(easy);
#endif
      curl_easy_cleanup(easy);
      curl_global_cleanup();
      return result == CURLE_OK ? 0 : 1;
    }
  }
  curl_global_cleanup();
  return 1;
}
