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
  // iOS remains gated until the standard Release transport is qualified.
  if (Platform.OS !== 'android') throw new ApplicationHttpError('configuration');

  return createApplicationHttpClient({
    ...config,
    transport: createNativeHttpsTransport(() =>
      requireNativeModule<ApplicationHttpsModule>('ApplicationHttps'),
    ),
  });
}
