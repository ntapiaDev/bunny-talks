import { requireNativeModule } from 'expo';

interface BoundedHttps {
  start(id: string, url: string, method: string, limit: number, timeout: number): void;
  read(id: string): Promise<{ status: number; contentType: string | null; bytes: Uint8Array }>;
  cancel(id: string): void;
}

// Load lazily so existing diagnostics still work without a rebuilt binary.
export function getBoundedHttps(): BoundedHttps {
  return requireNativeModule<BoundedHttps>('BoundedHttps');
}
