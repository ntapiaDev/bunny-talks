import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import manifest from '../package.json';

const mobile = resolve(import.meta.dirname, '..');
const resolveExpo = createRequire(import.meta.url).resolve;

function readExpoOutput(binary: string, args: string[], overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bunny-expo-config-'));
  const output = join(directory, 'output.json');
  try {
    const descriptor = openSync(output, 'wx', 0o600);
    try {
      execFileSync(process.execPath, [resolveExpo(binary), ...args, '--json'], {
        cwd: mobile,
        env: {
          ...process.env,
          BUNNY_CRYPTO_QUALIFICATION: undefined,
          BUNNY_CRYPTO_HISTORICAL_REQUALIFICATION: undefined,
          BUNNY_CRYPTO_HISTORICAL_ENTRY: undefined,
          EXPO_PUBLIC_BUNNY_CRYPTO_QUALIFICATION: undefined,
          ...overrides,
          EXPO_OFFLINE: '1',
          EXPO_NO_DOTENV: '1',
          EXPO_NO_GIT_STATUS: '1',
        },
        stdio: ['ignore', descriptor, 'ignore'],
      });
    } finally {
      closeSync(descriptor);
    }
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it('resolves the standard Expo identity, minimum iOS and ATS settings', () => {
  const config = readExpoOutput('expo/bin/cli', ['config', '--type', 'introspect']);
  const ios = config._internal.modResults.ios;
  expect(manifest.main).toBe('index.ts');
  expect(config.name).toBe('Bunny Talks');
  expect(config.slug).toBe('bunny-talks');
  expect(config.scheme).toBe('bunnytalks');
  expect(config.sdkVersion).toBe('57.0.0');
  expect(config.extra?.eas?.projectId).toBeUndefined();
  expect(config.ios.bundleIdentifier).toBe('fr.bunnytalks.mobile');
  expect(config.android.package).toBe('fr.bunnytalks.mobile');
  expect(ios.podfileProperties).toMatchObject({
    'ios.deploymentTarget': '16.4',
    'expo.sqlite.useSQLCipher': 'true',
  });
  expect(ios.infoPlist.BunnyApplicationHttpsOrigin).toBeUndefined();
  expect(ios.infoPlist.NSAppTransportSecurity).toEqual({ NSAllowsArbitraryLoads: false });
  expect(JSON.stringify(config.plugins)).not.toContain('qualification');
});

it('resolves an isolated synthetic crypto qualification identity', () => {
  const config = readExpoOutput('expo/bin/cli', ['config', '--type', 'introspect'], {
    BUNNY_CRYPTO_QUALIFICATION: 'synthetic',
  });
  expect(config.android.package).toBe('fr.bunnytalks.mobile.cryptoqualification');
  expect(config.ios.bundleIdentifier).toBe('fr.bunnytalks.mobile.cryptoqualification');
  expect(manifest.main).toBe('index.ts');
});

it('resolves the initialization identity independently of standard and B1', () => {
  const config = readExpoOutput('expo/bin/cli', ['config', '--type', 'public'], {
    BUNNY_CRYPTO_QUALIFICATION: 'initialization',
    EXPO_PUBLIC_BUNNY_CRYPTO_QUALIFICATION: 'initialization',
  });
  expect(config.android.package).toBe('fr.bunnytalks.mobile.cryptoinitialization');
  expect(config.ios.bundleIdentifier).toBe('fr.bunnytalks.mobile');
  expect(manifest.main).toBe('index.ts');
});

it('rejects contradictory initialization selectors', () => {
  expect(() =>
    readExpoOutput('expo/bin/cli', ['config', '--type', 'public'], {
      BUNNY_CRYPTO_QUALIFICATION: 'initialization',
      EXPO_PUBLIC_BUNNY_CRYPTO_QUALIFICATION: 'synthetic',
    }),
  ).toThrow();
});

it('guards the Android crypto entry by qualification profile and application identity', () => {
  const script = readFileSync(resolve(mobile, 'qualification/crypto/android.init.gradle'), 'utf8');
  expect(script).toContain('BUNNY_CRYPTO_QUALIFICATION');
  expect(script).toContain('BUNNY_CRYPTO_HISTORICAL_REQUALIFICATION');
  expect(script).toContain('BUNNY_CRYPTO_HISTORICAL_ENTRY');
  expect(script).not.toContain("'fr.bunnytalks.mobile'");
  expect(script).not.toContain("'historical'");
  expect(script).toContain("'synthetic'");
  expect(script).toContain("'fr.bunnytalks.mobile.cryptoqualification'");
  expect(script).toContain("'fr.bunnytalks.mobile.cryptoinitialization'");
  expect(script).toContain('android.defaultConfig.applicationId != packageId');
  expect(script).toContain("'entry.tsx'");
  expect(readFileSync(resolve(mobile, 'qualification/crypto/entry.tsx'), 'utf8')).toContain(
    "import '../../src/infrastructure/crypto/random-provider'",
  );
});

it.each([
  { BUNNY_CRYPTO_QUALIFICATION: 'historical' },
  {
    BUNNY_CRYPTO_QUALIFICATION: 'historical',
    BUNNY_CRYPTO_HISTORICAL_REQUALIFICATION: 'AUTHORIZED',
    BUNNY_CRYPTO_HISTORICAL_ENTRY: 'qualification/crypto/entry.tsx',
    EXPO_PUBLIC_BUNNY_CRYPTO_QUALIFICATION: 'historical',
  },
  { BUNNY_CRYPTO_HISTORICAL_REQUALIFICATION: 'AUTHORIZED' },
  { BUNNY_CRYPTO_HISTORICAL_ENTRY: 'qualification/crypto/entry.tsx' },
  { EXPO_PUBLIC_BUNNY_CRYPTO_QUALIFICATION: 'historical' },
  {
    BUNNY_CRYPTO_QUALIFICATION: 'synthetic',
    EXPO_PUBLIC_BUNNY_CRYPTO_QUALIFICATION: 'historical',
  },
])('rejects retired historical settings %j', (env) => {
  expect(() => readExpoOutput('expo/bin/cli', ['config', '--type', 'public'], env)).toThrow();
});

it('autolinks ApplicationHttps on Apple and Android from the local module', () => {
  const apple = readExpoOutput('expo/bin/autolinking', ['resolve', '--platform', 'apple']);
  expect(apple.modules).toContainEqual(
    expect.objectContaining({
      packageName: 'application-https',
      pods: [
        {
          podName: 'ApplicationHttps',
          podspecDir: resolve(mobile, 'modules/application-https/ios'),
        },
      ],
      swiftModuleNames: ['ApplicationHttps'],
      modules: [{ name: null, class: 'ApplicationHttpsModule' }],
      debugOnly: false,
    }),
  );
  expect(apple.modules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        packageName: 'expo-sqlite',
        pods: [expect.objectContaining({ podName: 'ExpoSQLite' })],
      }),
      expect.objectContaining({
        packageName: 'expo-secure-store',
        pods: [expect.objectContaining({ podName: 'ExpoSecureStore' })],
      }),
    ]),
  );
  const android = readExpoOutput('expo/bin/autolinking', ['resolve', '--platform', 'android']);
  for (const packageName of [
    'expo-sqlite',
    'expo-secure-store',
    'expo-file-system',
    '@sonnetstationsolutions/expo-argon2',
  ]) {
    expect(
      android.modules.filter((entry: { packageName: string }) => entry.packageName === packageName),
    ).toHaveLength(1);
  }
  expect(android.modules).toContainEqual(
    expect.objectContaining({
      packageName: 'application-https',
      projects: [
        expect.objectContaining({
          sourceDir: resolve(mobile, 'modules/application-https/android'),
          modules: [
            { classifier: 'fr.bunnytalks.applicationhttps.ApplicationHttpsModule', name: null },
          ],
        }),
      ],
    }),
  );
});
