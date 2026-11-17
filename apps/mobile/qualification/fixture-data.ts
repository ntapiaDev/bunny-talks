export const fixtureJson = JSON.stringify({ message: 'Bonjour 🐰 — 日本語 — العربية' });

export function bytesMatchFixture(bytes: Uint8Array): boolean {
  const expected = new TextEncoder().encode(fixtureJson);
  return bytes.length === expected.length && expected.every((byte, index) => byte === bytes[index]);
}

export function nativeErrorCategory(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'ERR_REDIRECT':
      return 'redirection refusée';
    case 'ERR_SIZE':
      return 'taille dépassée';
    case 'ERR_NETWORK':
      return 'erreur réseau';
    case 'ERR_CONFIGURATION':
      return 'configuration';
    default:
      return 'erreur non classée';
  }
}
