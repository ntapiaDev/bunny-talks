import { useState } from 'react';
import { Button, SafeAreaView, ScrollView, Text } from 'react-native';
import { applicationVaultArgon2Provider } from './crypto-composition';
import type { DiagnosticEntry } from './diagnostics';
import { runDiagnostics } from './diagnostics';
import { createNativeVaultDiagnostics } from './native-vault-diagnostics';
import { runVaultDiagnostics } from './vault-diagnostics';

export default function App() {
  const [vaultDiagnostic] = useState(() =>
    createNativeVaultDiagnostics(applicationVaultArgon2Provider),
  );
  const [pulse, setPulse] = useState(0);
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    setEntries([]);
    try {
      await runDiagnostics((entry) => setEntries((current) => [...current, entry]));
    } finally {
      setRunning(false);
    }
  };
  const runVault = async (full: boolean) => {
    setRunning(true);
    setEntries([]);
    try {
      await runVaultDiagnostics((entry) => setEntries((current) => [...current, entry]), full);
    } finally {
      setRunning(false);
    }
  };
  const runNative = async (reopen = false) => {
    setRunning(true);
    setEntries([]);
    try {
      await vaultDiagnostic[reopen ? 'reopen' : 'next']((entry) =>
        setEntries((current) => [...current, entry]),
      );
    } finally {
      setRunning(false);
    }
  };
  return (
    <SafeAreaView style={{ flex: 1, padding: 20 }}>
      <ScrollView>
        <Text>Diagnostic local OpenE2EE</Text>
        <Text>Les données de test restent dans des stores distincts sur cet appareil.</Text>
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
