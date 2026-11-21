#ifndef BUNNY_HTTPS_NATIVE_H
#define BUNNY_HTTPS_NATIVE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct BunnyHttpsRequest BunnyHttpsRequest;

typedef enum {
  BunnyHttpsNetwork,
  BunnyHttpsTimeout,
  BunnyHttpsRedirect,
  BunnyHttpsResponse,
  BunnyHttpsSize,
  BunnyHttpsSuccess
} BunnyHttpsOutcome;

typedef struct {
  BunnyHttpsOutcome outcome;
  int status;
  char content_type[256];
  void *bytes;
  size_t size;
} BunnyHttpsResult;

// The caller owns the request. Only cancel may run concurrently with perform.
BunnyHttpsRequest *bunny_https_create(void);
bool bunny_https_add_header(BunnyHttpsRequest *, const char *header);
bool bunny_https_is_bearer_authorization(const char *value);
void bunny_https_cancel(BunnyHttpsRequest *);
void bunny_https_destroy(BunnyHttpsRequest *);

// Body storage must remain valid until perform returns. Success transfers malloc-owned bytes.
BunnyHttpsResult bunny_https_perform(BunnyHttpsRequest *, const char *url, const char *method,
                                    const void *body, size_t body_size, size_t limit,
                                    uint64_t deadline_ns);

// Record only fixed, reviewed values from the actual linked libraries.
const char *bunny_https_runtime_profile(void);

#endif
