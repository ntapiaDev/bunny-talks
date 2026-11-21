import { deepEqual, equal, throws } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkBuildVersions,
  checkArchiveMembers,
  checkCurlConfig,
  checkDynamicDependencies,
  checkHeaderFile,
  checkOpenSSLConfig,
  selectSDKs,
} from './build.mjs';

test('header inspection admits ASCII hyphens and retains file, digest and PEM checks', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'headers-check.'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const hashes = {};
  const name = 'typecheck-gcc.h';
  writeFileSync(join(root, name), 'header content');
  checkHeaderFile(root, name, hashes, name);
  equal(hashes[name], createHash('sha256').update('header content').digest('hex'));
  writeFileSync(join(root, name), 'changed content');
  checkHeaderFile(root, name, hashes, name);
  equal(hashes[name], createHash('sha256').update('changed content').digest('hex'));
  for (const invalid of [
    '.hidden.h',
    '../file.h',
    'dir/file.h',
    'dir\\file.h',
    'file.h.in',
    'file.hpp',
    'é.h',
  ]) {
    throws(() => checkHeaderFile(root, invalid, hashes, invalid));
  }
  mkdirSync(join(root, 'directory.h'));
  symlinkSync(join(root, name), join(root, 'link.h'));
  throws(() => checkHeaderFile(root, 'directory.h', hashes, 'directory.h'), /regular file/);
  throws(() => checkHeaderFile(root, 'link.h', hashes, 'link.h'), /regular file/);
  for (const material of ['CERTIFICATE', 'PRIVATE KEY']) {
    writeFileSync(join(root, 'pem.h'), `-----BEGIN ${material}-----\nsynthetic\n`);
    throws(() => checkHeaderFile(root, 'pem.h', hashes, 'pem.h'), /PEM material/);
  }
});

const curlConfig = [
  'USE_OPENSSL',
  'USE_APPLE_SECTRUST',
  'CURL_DISABLE_OPENSSL_AUTO_LOAD_CONFIG',
  'CURL_DISABLE_COOKIES',
  'CURL_DISABLE_ALTSVC',
  'CURL_DISABLE_HSTS',
  'CURL_DISABLE_WEBSOCKETS',
]
  .map((macro) => `#define ${macro} 1\n`)
  .join('');

test('configure checks require SecTrust and reject implicit CA sources and alternate libraries', () => {
  checkCurlConfig(curlConfig + '#undef CURL_CA_BUNDLE\n');
  throws(
    () => checkCurlConfig(curlConfig.replace('USE_APPLE_SECTRUST', 'USE_OTHER')),
    /Missing.*USE_APPLE_SECTRUST/,
  );
  for (const macro of [
    'CURL_CA_BUNDLE',
    'CURL_CA_PATH',
    'CURL_CA_FALLBACK',
    'USE_NGHTTP2',
    'USE_GNUTLS',
  ]) {
    throws(() => checkCurlConfig(curlConfig + `#define ${macro} 1\n`), new RegExp(macro));
  }
});

test('OpenSSL configure checks reject a feature moved out of the disabled section', () => {
  const features = ['shared', 'module', 'dso', 'tests', 'apps', 'autoload-config'];
  const disabled = features.map((feature) => `    ${feature} [option]\n`).join('');
  checkOpenSSLConfig(`Disabled features:\n${disabled}\nConfig target attributes:\n`);
  throws(
    () => checkOpenSSLConfig(`Enabled features:\n${disabled}\nDisabled features:\n`),
    /OpenSSL feature was not disabled/,
  );
});

const member = (platform, minimum = '16.4', sdk = 'n/a') => `archive.a(member.o):
Load command 0
      cmd LC_SEGMENT_64
Load command 1
      cmd LC_BUILD_VERSION
 platform ${platform}
    minos ${minimum}
      sdk ${sdk}
`;

// These strings exercise parser branches. Only the real tools can inspect Apple artifacts.
test('Mach-O parser rejects mixed slices, wrong minimum and incomplete archive inspection', () => {
  const archive = member('IOS') + member('2', '16.4', '26.5');
  deepEqual(checkBuildVersions(archive, 2, 2), {
    platform: 'IOS',
    minimumOS: '16.4',
    sdks: ['26.5', 'unspecified'],
    members: 2,
  });
  checkBuildVersions(member('IOSSIMULATOR', '16.4.0', '26.5'), 7, 1);
  throws(() => checkBuildVersions(archive, 2, 3), /Incomplete/);
  throws(() => checkBuildVersions(archive + member('IOSSIMULATOR'), 2, 3), /platform/);
  throws(() => checkBuildVersions(member('IOS', '26.5', '26.5'), 2, 1), /minos/);
  throws(() => checkBuildVersions(member('IOS'), 2, 1), /sdk/);
  throws(() => checkBuildVersions(archive + 'Load command 2\n cmd LC_LOAD_DYLIB\n', 2, 2), /DYLIB/);
});

test('Mach-O diagnostic names the failing member and control without forwarding tool text', () => {
  let observed;
  throws(
    () =>
      checkBuildVersions(
        member('IOS') + member('IOS', '26.5').replace('archive.a', '/private/output/archive.a'),
        2,
        2,
        (control, detail) => {
          observed = { control, ...detail };
        },
      ),
    /minos/,
  );
  deepEqual(observed, { control: 'macho-minimum-os', member: 2 });
});

test('link parser permits only canonical dependencies and requires Security', () => {
  const security = '/System/Library/Frameworks/Security.framework/Security';
  const system = '/usr/lib/libSystem.B.dylib';
  const line = (path) => `\t${path} (compatibility version 1.0.0, current version 1.0.0)\n`;
  const output = 'link-probe:\n' + line(system);
  deepEqual(checkDynamicDependencies(output + line(security)), [security, system]);
  throws(() => checkDynamicDependencies(output), /Security/);
  throws(
    () => checkDynamicDependencies(output + line(security) + line('/usr/lib/libcurl.4.dylib')),
    /Unexpected/,
  );
  throws(() => checkDynamicDependencies(output + line('@rpath/Security')), /Unexpected/);
});

test('SDK selection checks real directories and symlinks within the selected developer directory', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'private-sdk-check.'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const developerDir = join(root, 'Xcode.app', 'Contents', 'Developer');
  const valid = join(developerDir, 'somewhere', 'sdk');
  const outside = join(root, 'outside');
  mkdirSync(valid, { recursive: true });
  mkdirSync(outside);
  const link = join(root, 'valid-link');
  const broken = join(root, 'broken-link');
  const escaped = join(developerDir, 'escaped-link');
  const file = join(developerDir, 'file');
  symlinkSync(valid, link);
  symlinkSync(join(root, 'missing-target'), broken);
  symlinkSync(outside, escaped);
  writeFileSync(file, 'file');
  const attempt = (sdkPath, expected) => {
    const checks = [];
    const tools = {
      platform: 'darwin',
      arch: 'arm64',
      developerDir,
      run: () => 'Xcode 26.6\nBuild version 17F113',
      xcrun: (_sdk, flag) =>
        ({
          '--show-sdk-version': '26.5',
          '--show-sdk-build-version': '23F81a',
          '--show-sdk-path': sdkPath,
        })[flag],
    };
    const action = () =>
      selectSDKs((stage, control, detail) => {
        checks.push({ stage, control, ...detail });
      }, tools);
    if (expected === 'sdk-directory-valid') {
      deepEqual(
        action().map((item) => item.sdkPath),
        [sdkPath, sdkPath],
      );
    } else {
      throws(action);
    }
    const diagnostic = checks.find((item) => item.control === expected);
    deepEqual(diagnostic, { stage: 'toolchain', control: expected, sdk: 'iphoneos' });
    if (JSON.stringify(checks).includes(root)) throw new Error('Private path leaked');
  };
  attempt(valid, 'sdk-directory-valid');
  attempt(link, 'sdk-directory-valid');
  attempt(broken, 'sdk-directory-invalid-link');
  attempt(join(root, 'missing'), 'sdk-directory-missing');
  attempt(file, 'sdk-directory-unexpected');
  attempt(outside, 'sdk-directory-unexpected');
  attempt(escaped, 'sdk-directory-unexpected');
});

test('Darwin archive members classify symbol indexes and preserve bounded diagnostics', () => {
  for (const index of ['__.SYMDEF', '__.SYMDEF SORTED']) {
    equal(checkArchiveMembers(index + '\na.o\nb.o'), 2);
  }
  equal(checkArchiveMembers('a.o\nb.o'), 2);
  for (const [input, category] of [
    ['__.SYMDEF SORTED', 'no-objects'],
    ['__.SYMDEF\n__.SYMDEF SORTED\na.o', 'duplicate-index'],
    ['a.o\n__.SYMDEF', 'misplaced-index'],
    ['__.SYMDEF\na.o\n/private/secret', 'unexpected-entry'],
    ['bad/name.o', 'unexpected-entry'],
    ['', 'no-objects'],
  ]) {
    let diagnostic;
    throws(() =>
      checkArchiveMembers(input, (control, detail) => {
        diagnostic = { control, ...detail };
      }),
    );
    equal(diagnostic.category, category);
    equal(JSON.stringify(diagnostic).includes('secret'), false);
  }
  const count = checkArchiveMembers('__.SYMDEF SORTED\na.o\nb.o');
  throws(() => checkBuildVersions(member('IOS'), 2, count), /Incomplete/);
});
