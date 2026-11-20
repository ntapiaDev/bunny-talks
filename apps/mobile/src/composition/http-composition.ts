import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import {
  ApplicationHttpError,
  createApplicationHttpClient,
} from '../infrastructure/http/application-http';
import type { ApplicationHttpsModule } from '../infrastructure/http/native-https-transport';
import { createNativeHttpsTransport } from '../infrastructure/http/native-https-transport';

export function createMobileApplicationHttpClient(config: {
  origin: string;
  timeoutMs: number;
  maxResponseBytes: number;
}) {
  // URLSession can implicitly retry idempotent requests after a connection loss.
  if (Platform.OS !== 'android') throw new ApplicationHttpError('configuration');

  return createApplicationHttpClient({
    ...config,
    transport: createNativeHttpsTransport(() =>
      requireNativeModule<ApplicationHttpsModule>('ApplicationHttps'),
    ),
  });
}
