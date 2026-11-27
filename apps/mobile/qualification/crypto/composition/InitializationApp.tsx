import { DiagnosticsScreen } from '../diagnostics/DiagnosticsScreen';
import { initializationActions } from '../diagnostics/initialization-diagnostics';

export default function InitializationApp() {
  return <DiagnosticsScreen initializationActions={initializationActions} />;
}
