export async function prepareDiagnostic<T>(options: {
  loadModule: () => T;
  seedCookie: (signal: AbortSignal) => Promise<boolean>;
  timeoutMs: number;
}): Promise<{ native: T | null; messages: string[] }> {
  const messages: string[] = [];
  let native: T | null = null;
  try {
    native = options.loadModule();
    messages.push('Module BoundedHttps : chargé.');
  } catch {
    messages.push('Module BoundedHttps : chargement impossible.');
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = Symbol('timeout');
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError);
        controller.abort();
      }, options.timeoutMs);
    });
    const seeded = await Promise.race([options.seedCookie(controller.signal), timeout]);
    messages.push(
      seeded
        ? 'Ensemencement du cookie : réponse reçue ; vérifier les compteurs.'
        : 'Ensemencement du cookie : réponse incorrecte ; qualification cookie non concluante.',
    );
  } catch (error) {
    messages.push(
      error === timeoutError
        ? 'Ensemencement du cookie : délai dépassé ; qualification cookie non concluante.'
        : 'Ensemencement du cookie : erreur réseau ou TLS ; qualification cookie non concluante.',
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
  return { native, messages };
}
