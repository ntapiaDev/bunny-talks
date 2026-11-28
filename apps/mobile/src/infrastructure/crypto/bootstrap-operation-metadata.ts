import type { SqliteIdentityStore } from '@bunny-talks/crypto-engine';
import { initialBootstrapOperationMetadataKey } from './restricted-signal-store.ts';

export interface BootstrapOperationMetadataStore {
  assertAvailable(): void;
  read(expectedPublicationDigest?: string): Promise<string | null>;
  compareAndSet(
    expected: string | null,
    next: string,
    expectedPublicationDigest: string,
  ): Promise<{ readonly acquired: boolean | undefined; readonly observed: string | null }>;
}

export interface ExistingBootstrapAttempt {
  readonly publicationBytes: Uint8Array;
  readonly operationMetadata: string | null;
}

export interface BootstrapStoreContext {
  readonly account: string;
  readonly device: string;
  readonly vaultId: string;
}

export function validBootstrapStoreContext(context: BootstrapStoreContext): boolean {
  return (
    typeof context.account === 'string' &&
    /^[!-~]{1,128}$/u.test(context.account) &&
    typeof context.device === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(context.device) &&
    typeof context.vaultId === 'string' &&
    /^[A-Za-z0-9_-]{21}[AQgw]$/u.test(context.vaultId)
  );
}

export interface ExistingBootstrapMetadataStore extends BootstrapOperationMetadataStore {
  readonly context: BootstrapStoreContext;
  readAttempt(): Promise<ExistingBootstrapAttempt>;
}

export function createBootstrapOperationMetadataStore(
  withStore: <T>(
    work: (store: SqliteIdentityStore) => Promise<T>,
    expectedPublicationDigest?: string,
  ) => Promise<T>,
  assertAvailable: () => void,
): BootstrapOperationMetadataStore {
  return {
    assertAvailable,
    read: (expectedPublicationDigest) =>
      withStore(
        (store) => store.getMetadata(initialBootstrapOperationMetadataKey),
        expectedPublicationDigest,
      ),
    async compareAndSet(expected, next, expectedPublicationDigest) {
      if (
        typeof next !== 'string' ||
        next.length > 8192 ||
        typeof expectedPublicationDigest !== 'string'
      ) {
        throw new Error('Invalid bootstrap journal value');
      }
      return withStore(async (store) => {
        let acquired: boolean | undefined;
        try {
          acquired = await store.compareAndSetMetadata(
            initialBootstrapOperationMetadataKey,
            expected,
            next,
          );
        } catch {
          // Readback can establish durability after a lost response.
        }
        const observed = await store.getMetadata(initialBootstrapOperationMetadataKey);
        return { acquired, observed };
      }, expectedPublicationDigest);
    },
  };
}
