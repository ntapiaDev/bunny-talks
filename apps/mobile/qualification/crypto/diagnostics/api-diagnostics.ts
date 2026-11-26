import type { DiagnosticEntry } from './diagnostic-entry';

export type ApiDiagnosticResult =
  'success' | 'unavailable' | 'network' | 'timeout' | 'http' | 'invalid';

const labels: Record<ApiDiagnosticResult, string> = {
  success: 'Connexion à l’API locale réussie',
  unavailable: 'Diagnostic API indisponible dans cet environnement',
  network: 'Connexion à l’API locale impossible',
  timeout: 'Délai de connexion à l’API locale dépassé',
  http: 'Réponse HTTP inattendue de l’API locale',
  invalid: 'Réponse invalide de l’API locale',
};

export function createApiDiagnostic(check: () => Promise<ApiDiagnosticResult>) {
  return async (report: (entry: DiagnosticEntry) => void): Promise<void> => {
    let result: ApiDiagnosticResult;
    try {
      result = await check();
    } catch {
      result = 'network';
    }
    report({ label: labels[result], status: result === 'success' ? 'pass' : 'fail' });
  };
}
