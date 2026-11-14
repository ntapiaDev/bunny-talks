// The witness contains only a digest of public state and an ephemeral process marker.
export function checkWitness(
  serialized: string,
  state: string,
  process: string,
): 'same-process' | 'new-process' {
  const value: unknown = JSON.parse(serialized);
  if (
    !value ||
    typeof value !== 'object' ||
    !('state' in value) ||
    !('process' in value) ||
    typeof value.state !== 'string' ||
    typeof value.process !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.state) ||
    !value.process ||
    value.state !== state
  ) {
    throw new Error('Diagnostic witness mismatch');
  }
  return value.process === process ? 'same-process' : 'new-process';
}
