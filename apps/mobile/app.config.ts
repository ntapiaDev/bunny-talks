import type { ExpoConfig } from 'expo/config';
import appJson from './app.json';

const standard = appJson.expo as ExpoConfig;

export default function getAppConfig(): ExpoConfig {
  const profile = process.env.BUNNY_CRYPTO_QUALIFICATION;
  const historicalAuthorization = process.env.BUNNY_CRYPTO_HISTORICAL_REQUALIFICATION;
  if (!profile && historicalAuthorization === undefined) return standard;
  if (profile === 'synthetic') {
    if (historicalAuthorization !== undefined)
      throw new Error('Historical authorization conflicts with the synthetic profile');
    return {
      ...standard,
      android: { ...standard.android, package: 'fr.bunnytalks.mobile.cryptoqualification' },
      ios: { ...standard.ios, bundleIdentifier: 'fr.bunnytalks.mobile.cryptoqualification' },
    };
  }
  if (profile === 'historical' && historicalAuthorization === 'AUTHORIZED') {
    return standard;
  }
  throw new Error('Invalid or unauthorized crypto qualification profile');
}
