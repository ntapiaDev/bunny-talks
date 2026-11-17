import { runDiagnostics } from '../features/diagnostics/diagnostics';
import { DiagnosticsScreen } from '../features/diagnostics/DiagnosticsScreen';
import { createNativeVaultDiagnostics } from '../features/diagnostics/native-vault-diagnostics';
import { runVaultDiagnostics } from '../features/diagnostics/vault-diagnostics';
import { applicationVaultArgon2Provider } from './crypto-composition';

const createNativeDiagnostic = () => createNativeVaultDiagnostics(applicationVaultArgon2Provider);

export default function App() {
  return (
    <DiagnosticsScreen
      createNativeVaultDiagnostics={createNativeDiagnostic}
      runDiagnostics={runDiagnostics}
      runVaultDiagnostics={runVaultDiagnostics}
    />
  );
}
