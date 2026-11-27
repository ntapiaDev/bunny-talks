import type { ExpoConfig } from 'expo/config';
import appJson from './app.json';

const standard = appJson.expo as ExpoConfig;

export default function getAppConfig(): ExpoConfig {
  const profile = process.env.BUNNY_CRYPTO_QUALIFICATION;
  if (
    process.env.BUNNY_CRYPTO_HISTORICAL_REQUALIFICATION !== undefined ||
    process.env.BUNNY_CRYPTO_HISTORICAL_ENTRY !== undefined
  ) {
    throw new Error('The historical crypto qualification profile has been retired');
  }

  const publicProfile = process.env.EXPO_PUBLIC_BUNNY_CRYPTO_QUALIFICATION;
  if (profile === undefined && publicProfile === undefined) return standard;
  if (profile !== 'synthetic' || (publicProfile !== undefined && publicProfile !== profile)) {
    throw new Error('Invalid crypto qualification profile');
  }

  return {
    ...standard,
    android: { ...standard.android, package: 'fr.bunnytalks.mobile.cryptoqualification' },
    ios: { ...standard.ios, bundleIdentifier: 'fr.bunnytalks.mobile.cryptoqualification' },
  };
}
