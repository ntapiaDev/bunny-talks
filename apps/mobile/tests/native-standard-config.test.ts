import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import manifest from '../package.json';

const mobile = resolve(import.meta.dirname, '..');
const resolveExpo = createRequire(import.meta.url).resolve;

function readExpoOutput(binary: string, args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'bunny-expo-config-'));
  const output = join(directory, 'output.json');
  try {
    const descriptor = openSync(output, 'wx', 0o600);
    try {
      execFileSync(process.execPath, [resolveExpo(binary), ...args, '--json'], {
        cwd: mobile,
        env: { ...process.env, EXPO_OFFLINE: '1', EXPO_NO_DOTENV: '1', EXPO_NO_GIT_STATUS: '1' },
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
  expect(ios.infoPlist.NSAppTransportSecurity).toEqual({ NSAllowsArbitraryLoads: false });
  expect(JSON.stringify(config.plugins)).not.toContain('qualification');
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
