/** Refuse incomplete records; never overwrite a previously started diagnostic. */
export function classifyVaultDiagnosticRecords(
  records: readonly (string | null)[],
): 'fresh' | 'stored' | 'partial' {
  if (records.length !== 4) return 'partial';
  if (records.every((value) => value === null)) return 'fresh';
  if (records.every((value) => typeof value === 'string' && value.length > 0)) return 'stored';
  return 'partial';
}
