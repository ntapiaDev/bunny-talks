import { useRef, useState } from 'react';
import { Button, SafeAreaView, ScrollView, Text } from 'react-native';
import type { DiagnosticEntry } from './diagnostic-entry';

type Report = (entry: DiagnosticEntry) => void;
type DiagnosticsScreenProps = {
  createNativeVaultDiagnostics: () => {
    label: () => string;
    next: (report: Report) => Promise<void>;
    reopen: (report: Report) => Promise<void>;
  };
  runApiDiagnostic: (report: Report) => Promise<void>;
  runDiagnostics: (report: Report) => Promise<void>;
  runVaultDiagnostics: (report: Report, full: boolean) => Promise<void>;
};

export function DiagnosticsScreen({
  createNativeVaultDiagnostics,
  runApiDiagnostic,
  runDiagnostics,
  runVaultDiagnostics,
}: DiagnosticsScreenProps) {
  const [vaultDiagnostic] = useState(createNativeVaultDiagnostics);
  const [pulse, setPulse] = useState(0);
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const runExclusive = async (action: (report: Report) => Promise<void>) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setEntries([]);
    try {
      await action((entry) => setEntries((current) => [...current, entry]));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };
  const run = () => runExclusive(runDiagnostics);
  const runVault = (full: boolean) => runExclusive((report) => runVaultDiagnostics(report, full));
  const runNative = (reopen = false) =>
    runExclusive((report) => vaultDiagnostic[reopen ? 'reopen' : 'next'](report));
  return (
    <SafeAreaView style={{ flex: 1, padding: 20 }}>
      <ScrollView>
        <Text>Diagnostic local OpenE2EE</Text>
        <Text>Les données de test restent dans des stores distincts sur cet appareil.</Text>
        <Button
          title="Tester connexion API"
          disabled={running}
          onPress={() => void runExclusive(runApiDiagnostic)}
        />
        <Button title="Exécuter le diagnostic" disabled={running} onPress={() => void run()} />
        <Button
          title="Contrôles rapides du coffre"
          disabled={running}
          onPress={() => void runVault(false)}
        />
        <Button
          title="Diagnostic complet Noble désactivé"
          disabled
          onPress={() => void runVault(true)}
        />
        <Button
          title={vaultDiagnostic.label()}
          disabled={running}
          onPress={() => void runNative()}
        />
        <Button
          title="Réouvrir publication persistée"
          disabled={running}
          onPress={() => void runNative(true)}
        />
        <Button title={`Réactivité : ${pulse}`} onPress={() => setPulse((value) => value + 1)} />
        {entries.map((entry, index) => (
          <Text key={`${entry.label}-${index}`}>
            {entry.status === 'pass' ? 'OK' : entry.status === 'fail' ? 'Échec' : 'Info'} :{' '}
            {entry.label}
            {entry.durationMs === undefined ? '' : ` (${entry.durationMs} ms)`}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
