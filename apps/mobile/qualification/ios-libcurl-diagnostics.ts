export const diagnosticProbe = 'length-conflict';
export const transportFailures = ['response', 'network', 'timeout', 'size', 'redirect'] as const;
export const probeDiagnosticCodes = {
  native: [
    'not-observed',
    'bridge-rejected',
    'unexpected',
    'success',
    'partial-body',
    ...transportFailures,
  ],
  completion: [
    'unavailable',
    'unexpected',
    'not-completed',
    'weird-reply-before-headers',
    'weird-reply-after-headers',
    'write-error',
    'receive-error',
    'partial-file',
    'timeout',
    'ok',
    'other',
  ],
  adapter: ['not-observed', 'success', 'partial-body', ...transportFailures],
  client: [
    'not-observed',
    'unexpected',
    'success',
    'cancelled',
    'configuration',
    'request',
    'status',
    ...transportFailures,
  ],
  assertion: ['none', 'bridge', 'adapter', 'client', 'probe-evidence', 'slots'],
} as const;
export type ProbeDiagnostic = {
  -readonly [Key in keyof typeof probeDiagnosticCodes]: (typeof probeDiagnosticCodes)[Key][number];
};
