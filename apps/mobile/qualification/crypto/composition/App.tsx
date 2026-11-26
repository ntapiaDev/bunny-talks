import { Platform } from 'react-native';
import { createApiDiagnostic } from '../diagnostics/api-diagnostics';
import { runDiagnostics } from '../diagnostics/diagnostics';
import { DiagnosticsScreen } from '../diagnostics/DiagnosticsScreen';
import { createLocalApiHealthCheck } from '../diagnostics/local-api-health';
import { createNativeVaultDiagnostics } from '../diagnostics/native-vault-diagnostics';
import { runVaultDiagnostics } from '../diagnostics/vault-diagnostics';
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
