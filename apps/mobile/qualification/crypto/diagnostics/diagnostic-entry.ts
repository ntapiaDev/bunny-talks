export type DiagnosticEntry = {
  label: string;
  status: 'pass' | 'fail' | 'info';
  durationMs?: number;
};
