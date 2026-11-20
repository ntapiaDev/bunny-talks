import { Platform } from 'react-native';
import { createApiDiagnostic } from '../features/diagnostics/api-diagnostics';
import { runDiagnostics } from '../features/diagnostics/diagnostics';
import { DiagnosticsScreen } from '../features/diagnostics/DiagnosticsScreen';
import { createNativeVaultDiagnostics } from '../features/diagnostics/native-vault-diagnostics';
import { runVaultDiagnostics } from '../features/diagnostics/vault-diagnostics';
import { createLocalApiHealthCheck } from '../infrastructure/http/local-api-health';
import { applicationVaultArgon2Provider } from './crypto-composition';

const runApiDiagnostic = createApiDiagnostic(
  createLocalApiHealthCheck({
    development: __DEV__,
    platform: Platform.OS,
    fingerprint: Platform.OS === 'android' ? Platform.constants.Fingerprint : '',
    transport: fetch,
  }),
);

const createNativeDiagnostic = () => createNativeVaultDiagnostics(applicationVaultArgon2Provider);

export default function App() {
  return (
    <DiagnosticsScreen
      createNativeVaultDiagnostics={createNativeDiagnostic}
      runApiDiagnostic={runApiDiagnostic}
      runDiagnostics={runDiagnostics}
      runVaultDiagnostics={runVaultDiagnostics}
    />
  );
}
