import { expect } from 'vitest';

export async function expectKnownLengthResponse(response: Response): Promise<void> {
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('transfer-encoding')).toBeNull();
  const declared = response.headers.get('content-length');
  const received = (await response.clone().arrayBuffer()).byteLength;
  if (response.status === 204) {
    expect(declared).toBeNull();
    expect(received).toBe(0);
  } else {
    expect(response.headers.get('content-type')).toMatch(
      /^application\/json(?:;\s*charset=utf-8)?$/i,
    );
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThanOrEqual(1_048_576);
    expect(declared).toBe(String(received));
  }
}
