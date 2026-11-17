import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID } from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { Button, Platform, ScrollView, StatusBar, Text } from 'react-native';
import { getBoundedHttps } from '../modules/bounded-https';
import { bytesMatchFixture, nativeErrorCategory } from './fixture-data';
import { prepareDiagnostic } from './prepare-diagnostic';
import {
  memoryCycleCount,
  runCookieQualification,
  runEstablishedCancellation,
  runMemoryCycles,
} from './qualification-scenarios';

export function QualificationScreen() {
  const [output, setOutput] = useState('Fixture HTTPS Android — données artificielles');
  const [busy, setBusy] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      const controller = active.current;
      active.current = null;
      controller?.abort();
    },
    [],
  );

  const runExperiment = async (experiment: 'cancel' | 'cookies' | 'memory') => {
    if (busy || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    const report = (message: string) => setOutput((previous) => `${previous}\n${message}`);
    setOutput('Qualification HTTPS Android');
    try {
      let native: ReturnType<typeof getBoundedHttps>;
      try {
        native = getBoundedHttps();
      } catch {
        report('Module BoundedHttps indisponible. Qualification non concluante.');
        return;
      }
      if (experiment === 'cancel') {
        report(
          'Attendre que /slow/cancel affiche responseStarted=true et closed=false dans les compteurs.',
        );
        setCanCancel(true);
        await runEstablishedCancellation(
          native,
          controller.signal,
          report,
          () => active.current === controller,
        );
      } else if (experiment === 'cookies') {
        await runCookieQualification(
          native,
          randomUUID(),
          async (url, signal) => {
            const response = await expoFetch(url, {
              credentials: 'include',
              redirect: 'error',
              signal,
            });
            await response.arrayBuffer();
            return response.status === 200;
          },
          report,
          controller.signal,
        );
      } else {
        report(`Série mémoire de ${memoryCycleCount} cycles en cours.`);
        await runMemoryCycles(native, controller.signal, report);
      }
    } catch {
      report('Scénario interrompu. Qualification non concluante.');
    } finally {
      active.current = null;
      setCanCancel(false);
      setBusy(false);
    }
  };

  const run = async () => {
    if (busy || active.current) return;
    setBusy(true);
    const results: string[] = [];
    try {
      const preparation = await prepareDiagnostic({
        loadModule: getBoundedHttps,
        seedCookie: async (signal) => {
          const response = await expoFetch('https://10.0.2.2:9443/cookie', {
            credentials: 'include',
            redirect: 'error',
            signal,
          });
          await response.arrayBuffer();
          return response.status === 200;
        },
        timeoutMs: 1500,
      });
      results.push(...preparation.messages);
      const native = preparation.native;
      if (!native) {
        results.push('Tests natifs : non exécutés, module indisponible.');
        return;
      }
      for (const [id, url] of [
        ['positive-a', 'https://10.0.2.2:9443/destination'],
        ['positive-b', 'https://10.0.2.2:9444/destination'],
      ] as const) {
        try {
          native.start(id, url, 'GET', 1024, 1500);
          const result = await native.read(id);
          results.push(`${id}: ${result.status === 200 ? 'joignable' : 'échec'}`);
        } catch (error) {
          results.push(`${id}: ${nativeErrorCategory(error)} — contrôle non concluant`);
        }
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        try {
          const response = await expoFetch('http://10.0.2.2:9445/destination', {
            signal: controller.signal,
            redirect: 'error',
            credentials: 'omit',
          });
          await response.arrayBuffer();
          results.push(`positive-c: ${response.status === 200 ? 'joignable' : 'échec'}`);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        results.push('positive-c: échec de connexion — contrôle non concluant');
      }
      results.push(
        'Contrôler les compteurs A/B/C : seules les requêtes positive-* doivent atteindre /destination.',
      );
      const cases = [
        '/json',
        '/invalid',
        '/gzip',
        '/oversize',
        '/truncated',
        '/length',
        '/cookie',
        '/json',
        '/challenge',
        '/slow',
      ];
      for (const status of [301, 302, 303, 307, 308])
        for (const destination of ['same', 'host', 'http'])
          cases.push(`/redirect/${status}/${destination}`);
      for (const [index, path] of cases.entries()) {
        const id = `case-${index}`;
        try {
          native.start(id, `https://10.0.2.2:9443${path}`, 'GET', 1_048_576, 1500);
          const response = await native.read(id);
          let json = true;
          try {
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes));
          } catch {
            json = false;
          }
          const exact = bytesMatchFixture(response.bytes);
          results.push(
            `${path}: status=${response.status}, bytes=${response.bytes.length}, JSON=${json}${path === '/json' || path === '/gzip' ? `, octets exacts=${exact}` : ''}`,
          );
        } catch (error) {
          results.push(`${path}: ${nativeErrorCategory(error)}`);
        } finally {
          native.cancel(id);
        }
      }
      for (const status of [301, 302, 303, 307, 308]) {
        for (const target of ['same', 'host', 'http']) {
          const id = `post-${status}-${target}`;
          try {
            native.start(
              id,
              `https://10.0.2.2:9443/redirect/${status}/${target}`,
              'POST',
              1024,
              1500,
            );
            await native.read(id);
            results.push(`${id}: accepté (ÉCHEC)`);
          } catch (error) {
            results.push(`${id}: ${nativeErrorCategory(error)}`);
          }
        }
      }
      for (const port of [9446, 9447]) {
        const id = `tls-${port}`;
        try {
          native.start(id, `https://10.0.2.2:${port}/json`, 'GET', 1024, 1500);
          await native.read(id);
          results.push(`${port}: accepté (ÉCHEC attendu refus)`);
        } catch (error) {
          results.push(`${port}: ${nativeErrorCategory(error)} — vérifier le contrôle TLS positif`);
        }
      }
      const pending: Promise<unknown>[] = [];
      for (let i = 0; i < 3; i++) {
        try {
          native.start(`parallel-${i}`, 'https://10.0.2.2:9443/slow', 'GET', 1024, 1500);
          pending.push(native.read(`parallel-${i}`).catch(() => undefined));
          results.push(`parallel-${i}: admis`);
        } catch {
          results.push(`parallel-${i}: refus admission`);
        }
      }
      await Promise.all(pending);
    } catch {
      results.push('Tests natifs : interruption inattendue ; résultats incomplets.');
    } finally {
      setOutput(results.join('\n'));
      setBusy(false);
    }
  };
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 32) + 16 : 24,
        paddingHorizontal: 16,
        paddingBottom: 32,
      }}
    >
      <Text selectable>{output}</Text>
      <Button
        title="Exécuter les fixtures"
        disabled={busy}
        onPress={() => {
          void run();
        }}
      />
      <Button
        title="Démarrer la connexion lente"
        disabled={busy}
        onPress={() => void runExperiment('cancel')}
      />
      <Button
        title="Annuler après confirmation serveur"
        disabled={!canCancel}
        onPress={() => {
          setCanCancel(false);
          active.current?.abort();
        }}
      />
      <Button
        title="Vérifier l’isolation des cookies"
        disabled={busy}
        onPress={() => void runExperiment('cookies')}
      />
      <Button
        title="Lancer cinq cycles mémoire"
        disabled={busy}
        onPress={() => void runExperiment('memory')}
      />
    </ScrollView>
  );
}
