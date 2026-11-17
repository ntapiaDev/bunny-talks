import type { getBoundedHttps } from '../modules/bounded-https';
import { bytesMatchFixture, nativeErrorCategory } from './fixture-data';

type Native = ReturnType<typeof getBoundedHttps>;
type NativeResponse = Awaited<ReturnType<Native['read']>>;

const origin = 'https://10.0.2.2:9443';

async function readFixture(
  native: Native,
  id: string,
  path: string,
  timeout: number,
  signal?: AbortSignal,
  limit = 1_048_576,
): Promise<NativeResponse> {
  if (signal?.aborted) throw new Error('Canceled');
  native.start(id, origin + path, 'GET', limit, timeout);
  const cancel = () => native.cancel(id);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await native.read(id);
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
  }
}

export async function runEstablishedCancellation(
  native: Native,
  signal: AbortSignal,
  report: (message: string) => void,
  canCheckReuse: () => boolean,
) {
  try {
    await readFixture(native, 'confirmed-abort', '/slow/cancel', 60_000, signal);
    report('Annulation : la lecture a abouti. Qualification non concluante.');
    return;
  } catch (error) {
    const category = nativeErrorCategory(error);
    report(`Lecture lente : ${category}.`);
    if (!signal.aborted || category !== 'erreur réseau') {
      report('Annulation non concluante. Relancer après vérification des compteurs.');
      return;
    }
  }
  if (!canCheckReuse()) return;
  const reserved: string[] = [];
  let reusable = false;
  try {
    // Reserve both slots before any read can finish and release one.
    for (const name of ['one', 'two']) {
      const id = `reuse-${name}`;
      native.start(id, `${origin}/reuse/${name}`, 'GET', 1024, 1500);
      reserved.push(id);
    }
    const probes = await Promise.allSettled(reserved.map(async (id) => native.read(id)));
    reusable = probes.every(
      (probe) =>
        probe.status === 'fulfilled' &&
        probe.value.status === 200 &&
        bytesMatchFixture(probe.value.bytes),
    );
  } catch {
    // A rejected reservation leaves the recovery check inconclusive.
  } finally {
    for (const id of reserved) native.cancel(id);
  }
  report(
    reusable
      ? 'Réutilisation : deux requêtes abouties. Vérifier les compteurs et la fermeture prématurée.'
      : 'Réutilisation : contrôle non concluant. Vérifier les compteurs.',
  );
}

type ExpoCookieRequest = (url: string, signal: AbortSignal) => Promise<boolean>;

async function requestCookieControl(
  request: ExpoCookieRequest,
  url: string,
  signal: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 1500);
    });
    return await Promise.race([request(url, controller.signal), timeout]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    controller.abort();
  }
}

export async function runCookieQualification(
  native: Native,
  runId: string,
  expoRequest: ExpoCookieRequest,
  report: (message: string) => void,
  signal: AbortSignal,
) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) {
    report('Cookies : identifiant de fixture incorrect. Qualification non concluante.');
    return;
  }
  const prefix = `/cookies/${runId}/`;
  report(`Cookies : passage ${runId}.`);
  const steps = [
    ['baseline', 'expo'],
    ['seed', 'expo'],
    ['expo-probe', 'expo'],
    ['native-probe', 'native'],
    ['native-set', 'native'],
    ['expo-after', 'expo'],
  ] as const;
  for (const [step, client] of steps) {
    if (signal.aborted) return;
    try {
      const ok =
        client === 'expo'
          ? await requestCookieControl(expoRequest, origin + prefix + step, signal)
          : (await readFixture(native, step, prefix + step, 1500, signal, 1024)).status === 200;
      if (ok) continue;
      report(`Cookies ${step} : réponse ou connexion non confirmée. Qualification non concluante.`);
    } catch (error) {
      report(`Cookies ${step} : ${nativeErrorCategory(error)}. Qualification non concluante.`);
    }
    return;
  }
  report('Cookies : six réponses HTTP 200. Qualification à vérifier dans les compteurs.');
}

export const memoryCycleCount = 5;

export async function runMemoryCycles(
  native: Native,
  signal: AbortSignal,
  report: (message: string) => void,
) {
  for (let cycle = 1; cycle <= memoryCycleCount && !signal.aborted; cycle++) {
    const record = async (label: string, response: Promise<NativeResponse>) => {
      try {
        const { status, bytes } = await response;
        report(`Cycle ${cycle} ${label} : HTTP ${status}, ${bytes.length} octets.`);
      } catch (error) {
        report(`Cycle ${cycle} ${label} : ${nativeErrorCategory(error)}.`);
      }
    };
    await Promise.all([
      record('gzip', readFixture(native, 'gzip', '/memory/gzip', 3000, signal)),
      record('dépassement', readFixture(native, 'oversize', '/oversize', 3000, signal)),
    ]);
    if (signal.aborted) return;
    await record('coupure', readFixture(native, 'truncated', '/truncated', 3000, signal));

    if (signal.aborted) return;
    const cancelLoad = new AbortController();
    const stop = () => cancelLoad.abort();
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 300);
    try {
      await Promise.all([
        record(
          'timeout',
          readFixture(native, 'memory-timeout', '/slow/memory-timeout', 1500, signal),
        ),
        record(
          'annulation',
          readFixture(native, 'memory-cancel', '/slow/memory-cancel', 5000, cancelLoad.signal),
        ),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  }
}
