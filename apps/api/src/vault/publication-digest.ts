import { createHash } from 'node:crypto';

/** SHA-256 of the exact publication bytes, encoded as unpadded base64url. */
export function publicationDigest(publication: Uint8Array): string {
  return createHash('sha256').update(publication).digest('base64url');
}
