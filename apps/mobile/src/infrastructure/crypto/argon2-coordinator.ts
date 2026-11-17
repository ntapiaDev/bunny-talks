/** Rejects concurrent work; the lease lasts until the underlying promise actually settles. */
export function createArgon2Coordinator() {
  let active = false;
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (active) throw new Error('ARGON2_BUSY');
      active = true;
      try {
        return await operation();
      } finally {
        active = false;
      }
    },
  };
}
