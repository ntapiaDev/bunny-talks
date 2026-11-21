import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  realpathSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const minimumOS = '16.4';
const sdkVersion = '26.5';
const xcode = 'Xcode 26.6\nBuild version 17F113';
const variants = [
  {
    sdk: 'iphoneos',
    machPlatform: 2,
    id: 'ios-arm64',
    target: 'arm64-apple-ios16.4',
    opensslTarget: 'ios64-xcrun',
  },
  {
    sdk: 'iphonesimulator',
    machPlatform: 7,
    id: 'ios-arm64-simulator',
    target: 'arm64-apple-ios16.4-simulator',
    opensslTarget: 'iossimulator-arm64-xcrun',
  },
];
const upstream = [
  {
    directory: 'curl-8.23.0',
    archive: 'curl-8.23.0.tar.xz',
    url: 'https://curl.se/download/curl-8.23.0.tar.xz',
    sha256: '8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5',
  },
  {
    directory: 'openssl-3.5.9',
    archive: 'openssl-3.5.9.tar.gz',
    url: 'https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz',
    sha256: '603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a',
  },
];
const opensslPrefix = '/var/empty/bunny-openssl';
const opensslFlags = [
  'no-shared',
  'no-module',
  'no-dso',
  'no-tests',
  'no-apps',
  'no-autoload-config',
  `--prefix=${opensslPrefix}`,
  `--openssldir=${opensslPrefix}`,
  '--libdir=lib',
];
const curlFlags = [
  '--enable-option-checking=fatal',
  '--disable-shared',
  '--enable-static',
  '--with-apple-sectrust',
  '--without-apple-idn',
  '--disable-openssl-auto-load-config',
  '--without-ca-bundle',
  '--without-ca-path',
  '--without-ca-fallback',
  '--without-nghttp2',
  '--without-nghttp3',
  '--without-ngtcp2',
  '--without-quiche',
  '--without-zlib',
  '--without-brotli',
  '--without-zstd',
  '--without-libpsl',
  '--without-libidn2',
  '--disable-alt-svc',
  '--disable-hsts',
  '--disable-websockets',
  '--disable-cookies',
  '--disable-dict',
  '--disable-ftp',
  '--disable-file',
  '--disable-ldap',
  '--disable-ldaps',
  '--disable-rtsp',
  '--disable-telnet',
  '--disable-tftp',
  '--disable-pop3',
  '--disable-imap',
  '--disable-smtp',
  '--disable-gopher',
  '--disable-mqtt',
  '--disable-ipfs',
  '--disable-docs',
  '--disable-manual',
];
// These are upstream SecTrust link flags. The probe records which ones survive linking.
const frameworks = ['CoreFoundation', 'CoreServices', 'Security'];
const allowedLibraries = new Set([
  ...frameworks.map((name) => `/System/Library/Frameworks/${name}.framework/${name}`),
  '/usr/lib/libSystem.B.dylib',
]);
const libraries = [
  { name: 'libcurl', headers: 'curl', header: 'curl.h' },
  { name: 'libopenssl', headers: 'openssl', header: 'ssl.h' },
];
const buildFlags = ['-O2', '-DNDEBUG', '-Werror=unguarded-availability'];
const sourceDateEpoch = '0';
export const profile = {
  format: 2,
  xcode,
  sdkVersion,
  minimumOS,
  architecture: 'arm64',
  configuration: 'Release',
  variants,
  upstream,
  buildFlags,
  opensslFlags,
  curlFlags,
  frameworks,
  sourceDateEpoch,
  patches: [],
  fixtureBuildDefine: 'BUNNY_QUALIFICATION_CA',
};

const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LC_ALL: 'C',
  TZ: 'UTC',
  CONFIG_SITE: '/dev/null',
  PKG_CONFIG: 'false',
  SOURCE_DATE_EPOCH: sourceDateEpoch,
  ZERO_AR_DATE: '1',
  ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
};

const ignoreCheck = () => {};
export const packageFiles = [
  'curl-COPYING',
  'libcurl.xcframework',
  'libopenssl.xcframework',
  'manifest.json',
  'openssl-LICENSE.txt',
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

const xcrun = (sdk, ...args) => run('xcrun', ['--sdk', sdk, ...args]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path) => sha256(readFileSync(path));

export function verifyArchives(paths, check = ignoreCheck) {
  upstream.forEach(({ archive, sha256: expected }, index) => {
    check('archives', 'sha256', { archive });
    assert.equal(fileHash(paths[index]), expected, `${archive}: SHA-256 mismatch`);
  });
}

export function checkCurlConfig(config, check = ignoreCheck) {
  const macros = new Set([...config.matchAll(/^#define[ \t]+(\w+)\b/gm)].map((match) => match[1]));
  for (const required of [
    'USE_OPENSSL',
    'USE_APPLE_SECTRUST',
    'CURL_DISABLE_OPENSSL_AUTO_LOAD_CONFIG',
    'CURL_DISABLE_COOKIES',
    'CURL_DISABLE_ALTSVC',
    'CURL_DISABLE_HSTS',
    'CURL_DISABLE_WEBSOCKETS',
  ]) {
    check('required-macro', required);
    assert(macros.has(required), `Missing curl configuration macro: ${required}`);
  }
  for (const forbidden of [
    'CURL_CA_BUNDLE',
    'CURL_CA_PATH',
    'CURL_CA_FALLBACK',
    'CURL_CA_NATIVE',
    'CURL_DISABLE_HTTP',
    'CURL_DISABLE_PROXY',
    'CURL_DISABLE_NETRC',
    'USE_NGHTTP2',
    'USE_NGHTTP3',
    'USE_NGTCP2',
    'USE_QUICHE',
    'USE_GNUTLS',
    'USE_RUSTLS',
    'USE_MBEDTLS',
    'USE_WOLFSSL',
    'USE_SCHANNEL',
    'USE_AMISSL',
    'USE_ARES',
    'HAVE_LIBZ',
    'HAVE_LIBZSTD',
    'HAVE_LIBBROTLIDEC',
    'USE_LIBPSL',
    'USE_LIBSSH',
    'USE_LIBSSH2',
    'USE_LIBUV',
    'USE_GSASL',
    'USE_OPENLDAP',
    'USE_ECH',
  ]) {
    check('forbidden-macro', forbidden);
    assert(!macros.has(forbidden), `Unexpected curl configuration macro: ${forbidden}`);
  }
}

export function checkOpenSSLConfig(config, check = ignoreCheck) {
  const disabled = config.split('Disabled features:\n')[1]?.split('\n\n')[0] ?? '';
  for (const option of opensslFlags.filter((flag) => flag.startsWith('no-'))) {
    check('disabled-feature', option);
    assert.match(
      disabled,
      new RegExp(`^[ \\t]+${option.slice(3)}[ \\t]+\\[`, 'm'),
      `OpenSSL feature was not disabled: ${option}`,
    );
  }
}

export function selectSDKs(check = ignoreCheck, tools = {}) {
  const hostPlatform = tools.platform ?? process.platform;
  const hostArch = tools.arch ?? process.arch;
  const command = tools.run ?? run;
  const sdkCommand = tools.xcrun ?? xcrun;
  check('toolchain', 'host-architecture');
  assert(
    hostPlatform === 'darwin' && hostArch === 'arm64',
    'The Apple steps require an Apple Silicon Mac and arm64 Node (NOT_RUN).',
  );
  check('toolchain', 'xcode-version');
  assert.equal(command('xcodebuild', ['-version']), xcode);
  return variants.map((variant) => {
    const { sdk } = variant;
    check('toolchain', 'sdk-version', { sdk });
    assert.equal(sdkCommand(sdk, '--show-sdk-version'), sdkVersion);
    check('toolchain', 'sdk-build', { sdk });
    const sdkBuild = sdkCommand(sdk, '--show-sdk-build-version');
    assert.match(sdkBuild, /^\d+[A-Z]\d+[a-z]?$/);
    check('toolchain', 'sdk-directory', { sdk });
    const sdkPath = sdkCommand(sdk, '--show-sdk-path');
    let status = 'sdk-directory-missing';
    let entry;
    try {
      entry = lstatSync(sdkPath);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (entry) {
      let destination;
      try {
        destination = realpathSync(sdkPath);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'ELOOP')
          throw error;
        status = 'sdk-directory-invalid-link';
      }
      if (destination) {
        status = 'sdk-directory-unexpected';
        const developerDir =
          tools.developerDir ?? env.DEVELOPER_DIR ?? command('xcode-select', ['-p']);
        const root = realpathSync(developerDir);
        const location = relative(root, destination);
        if (
          isAbsolute(sdkPath) &&
          location &&
          location !== '..' &&
          !location.startsWith('..' + sep) &&
          !isAbsolute(location) &&
          statSync(destination).isDirectory()
        ) {
          status = 'sdk-directory-valid';
        }
      }
    }
    check('toolchain', status, { sdk });
    assert.equal(status, 'sdk-directory-valid');
    return { ...variant, sdkBuild, sdkPath };
  });
}

function stageHeaders(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).filter((name) => name.endsWith('.h'))) {
    copyFileSync(join(from, name), join(to, name));
  }
}

function buildSlice(work, variant, archives, check) {
  const { sdk, target, opensslTarget, sdkPath } = variant;
  const directory = join(work, sdk);
  check('archives', 'extract', { sdk });
  mkdirSync(directory);
  const [curl, openssl] = upstream.map(({ directory: name }) => join(directory, name));
  run('tar', ['-xf', archives[0], '-C', directory]);
  run('tar', ['-xf', archives[1], '-C', directory]);
  const destination = join(directory, 'openssl-install');
  const prefix = join(destination, opensslPrefix);
  const sliceEnv = { ...env, SDKROOT: sdkPath };
  const flags = [`--target=${target}`, ...buildFlags];
  function buildCommand(log, cwd, command, args, extraEnv = {}) {
    const logPath = join(directory, log);
    try {
      writeFileSync(logPath, run(command, args, { cwd, env: { ...sliceEnv, ...extraEnv } }) + '\n');
    } catch (error) {
      writeFileSync(logPath, [error.stdout, error.stderr].filter(Boolean).join('\n'));
      throw new Error(`${sdk}: ${command} failed. See ${logPath}`, { cause: error });
    }
  }
  check('openssl-configure', 'configure', { sdk });
  buildCommand('openssl-configure.log', openssl, 'perl', [
    './Configure',
    opensslTarget,
    ...opensslFlags,
    ...flags,
  ]);
  check('openssl-configure', 'configdata', { sdk });
  checkOpenSSLConfig(
    run('perl', ['configdata.pm', '--dump'], { cwd: openssl, env: sliceEnv }),
    (control, option) => check('openssl-configure', control, { sdk, option }),
  );
  check('openssl-compile', 'make', { sdk });
  buildCommand('openssl-build.log', openssl, 'make', ['-j4']);
  check('openssl-compile', 'install', { sdk });
  buildCommand('openssl-install.log', openssl, 'make', [`DESTDIR=${destination}`, 'install_sw']);

  check('curl-configure', 'config-guess', { sdk });
  const host = run('./config.guess', [], { cwd: curl });
  check('curl-configure', 'configure', { sdk });
  buildCommand(
    'curl-configure.log',
    curl,
    './configure',
    [`--build=${host}`, '--host=aarch64-apple-darwin', `--with-openssl=${prefix}`, ...curlFlags],
    {
      CC: `xcrun --sdk ${sdk} clang`,
      CFLAGS: flags.join(' '),
      LDFLAGS: flags[0],
    },
  );
  check('curl-configure', 'configuration-header', { sdk });
  checkCurlConfig(readFileSync(join(curl, 'lib/curl_config.h'), 'utf8'), (control, option) =>
    check('curl-configure', control, { sdk, option }),
  );
  check('curl-compile', 'make', { sdk });
  buildCommand('curl-build.log', curl, 'make', ['-C', 'lib', '-j4']);

  const staging = join(directory, 'staging');
  check('packaging', 'stage-headers', { sdk });
  stageHeaders(join(curl, 'include/curl'), join(staging, 'libcurl/Headers/curl'));
  stageHeaders(join(prefix, 'include/openssl'), join(staging, 'libopenssl/Headers/openssl'));
  check('packaging', 'stage-libcurl', { sdk });
  copyFileSync(join(curl, 'lib/.libs/libcurl.a'), join(staging, 'libcurl/libcurl.a'));
  check('packaging', 'merge-openssl-archives', { sdk });
  xcrun(
    sdk,
    'libtool',
    '-static',
    '-o',
    join(staging, 'libopenssl/libopenssl.a'),
    join(prefix, 'lib/libssl.a'),
    join(prefix, 'lib/libcrypto.a'),
  );
  return staging;
}

function checkMachO(sdk, archive, variant, expectedObjects, check, isArchive = false) {
  check('macho-architecture');
  const architecture = xcrun(sdk, 'lipo', '-archs', archive);
  assert.equal(architecture, 'arm64');
  check('macho-load-commands');
  const commands = xcrun(sdk, 'otool', '-l', archive);
  return {
    architecture,
    ...checkBuildVersions(commands, variant.machPlatform, expectedObjects, check, isArchive),
  };
}

export function checkBuildVersions(
  loadCommands,
  machPlatform,
  expectedObjects,
  check = ignoreCheck,
  isArchive = expectedObjects > 1,
) {
  const objects = loadCommands.split(/^Load command 0[ \t]*$/m).slice(1);
  check('macho-member-count');
  assert.equal(objects.length, expectedObjects, 'Incomplete Mach-O inspection');
  const platformNames = machPlatform === 2 ? ['IOS', '2'] : ['IOSSIMULATOR', '7'];
  const observedSDKs = new Set();
  let control;
  let member = 0;
  try {
    for (const object of objects) {
      member++;
      control = 'macho-build-version';
      const commands = [...object.matchAll(/^\s*cmd LC_BUILD_VERSION\s*$/gm)];
      assert.equal(commands.length, 1, 'Missing or duplicate LC_BUILD_VERSION');
      const version = object.slice(commands[0].index).split(/^Load command /m)[0];
      control = 'macho-platform';
      assert(
        platformNames.includes(/^\s*platform\s+(\w+)/m.exec(version)?.[1].toUpperCase()),
        'Unexpected Mach-O platform',
      );
      control = 'macho-minimum-os';
      assert.match(version, /^\s*minos\s+16\.4(?:\.0)?\s*$/m);
      control = 'macho-sdk';
      const sdkPattern = !isArchive
        ? /^\s*sdk\s+26\.5(?:\.0)?\s*$/m
        : /^\s*sdk\s+(?:n\/a|0(?:\.0){0,2}|26\.5(?:\.0)?)\s*$/m;
      assert.match(version, sdkPattern);
      observedSDKs.add(/^\s*sdk\s+26\.5/m.test(version) ? sdkVersion : 'unspecified');
      if (isArchive) {
        control = 'macho-object-loads';
        assert.doesNotMatch(object, /\bLC_(?:[A-Z_]*DYLIB|RPATH)\b/);
      }
    }
  } catch (error) {
    check(control, { member });
    throw error;
  }
  return { platform: platformNames[0], minimumOS, sdks: [...observedSDKs].sort(), members: member };
}

function checkFile(path, hashes, key) {
  assert(lstatSync(path).isFile(), `${key}: expected a regular file`);
  const bytes = readFileSync(path);
  assert(
    !/-----BEGIN (?:[^-\r\n]*CERTIFICATE|[^-\r\n]*PRIVATE KEY)-----/.test(bytes.toString('latin1')),
    `${key}: unexpected PEM material`,
  );
  hashes[key] = sha256(bytes);
}

export function checkHeaderFile(directory, name, hashes, key) {
  assert.match(name, /^[a-z0-9_-]+\.h$/i);
  checkFile(join(directory, name), hashes, key);
}

export function checkArchiveMembers(output, check = ignoreCheck) {
  const lines = output === '' ? [] : output.split('\n');
  const indexes = new Set(['__.SYMDEF', '__.SYMDEF SORTED']);
  let indexCount = 0;
  let objectCount = 0;
  let unexpectedCount = 0;
  let misplaced = false;
  for (const [position, line] of lines.entries()) {
    if (indexes.has(line)) {
      indexCount++;
      if (position !== 0) misplaced = true;
    } else if (/^[A-Za-z0-9_][A-Za-z0-9_.+-]*\.o$/.test(line)) {
      objectCount++;
    } else {
      unexpectedCount++;
    }
  }
  const category = unexpectedCount
    ? 'unexpected-entry'
    : indexCount > 1
      ? 'duplicate-index'
      : misplaced
        ? 'misplaced-index'
        : objectCount === 0
          ? 'no-objects'
          : 'valid';
  check('archive-members', {
    category,
    indexCount: Math.min(indexCount, 10000),
    objectCount: Math.min(objectCount, 10000),
    unexpectedCount: Math.min(unexpectedCount, 10000),
  });
  assert.equal(category, 'valid');
  return objectCount;
}

function checkSlice(directory, variant, library, hashes, check) {
  const { id, sdk } = variant;
  const { name, headers, header } = library;
  const base = `${name}.xcframework/${id}`;
  const slice = join(directory, base);
  const archive = join(slice, `${name}.a`);
  check('slice-inventory');
  assert(lstatSync(slice).isDirectory());
  assert.deepEqual(readdirSync(slice).sort(), ['Headers', `${name}.a`]);
  assert(lstatSync(join(slice, 'Headers')).isDirectory());
  assert.deepEqual(readdirSync(join(slice, 'Headers')), [headers]);
  const include = join(slice, 'Headers', headers);
  assert(lstatSync(include).isDirectory());
  const headerNames = readdirSync(include).sort();
  assert(headerNames.includes(header));
  check('header-files');
  for (const name of headerNames) {
    const key = `${base}/Headers/${headers}/${name}`;
    checkHeaderFile(include, name, hashes, key);
  }
  check('archive-payload');
  checkFile(archive, hashes, `${base}/${name}.a`);
  assert.equal(readFileSync(archive).subarray(0, 8).toString('ascii'), '!<arch>\n');
  check('archive-members');
  const members = checkArchiveMembers(xcrun(sdk, 'ar', '-t', archive), check);
  const macho = checkMachO(sdk, archive, variant, members, check, true);
  return { archive, include: join(slice, 'Headers'), headerNames, library: name, macho };
}

function linkProbe(work, variant, slices, mode, check) {
  const { sdk, target } = variant;
  const binary = join(work, `link-${sdk}-${mode}`);
  check('clang-link');
  xcrun(
    sdk,
    'clang',
    `--target=${target}`,
    ...buildFlags,
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-DCURL_STATICLIB',
    ...(mode === 'qualification' ? ['-DBUNNY_QUALIFICATION_CA'] : []),
    ...slices.flatMap(({ include }) => ['-I', include]),
    join(source, 'link-probe.c'),
    ...slices.flatMap(({ archive }) => ['-Xlinker', '-force_load', '-Xlinker', archive]),
    ...frameworks.flatMap((name) => ['-framework', name]),
    '-o',
    binary,
  );
  const macho = checkMachO(sdk, binary, variant, 1, check);
  check('sectrust-import');
  assert.match(xcrun(sdk, 'nm', '-u', binary), /\b_SecTrustEvaluateWithError\b/);
  check('dynamic-dependencies');
  const dependencies = checkDynamicDependencies(xcrun(sdk, 'otool', '-L', binary));
  return { mode, macho, dependencies, importsSecTrust: true };
}

export function checkDynamicDependencies(output) {
  const dependencies = output
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((line) => {
      const match =
        /^\s+(\S+) \(compatibility version \d+\.\d+\.\d+, current version \d+\.\d+\.\d+(?:, weak)?\)$/.exec(
          line,
        );
      assert(
        match && allowedLibraries.has(match[1]),
        'Unexpected dynamic dependency in link probe',
      );
      return match[1];
    })
    .sort();
  assert(dependencies.includes('/System/Library/Frameworks/Security.framework/Security'));
  assert(dependencies.includes('/usr/lib/libSystem.B.dylib'));
  return dependencies;
}

function inspectPackage(directory, work, sdks, check) {
  const sha256 = {};
  const slicesById = new Map(sdks.map(({ id }) => [id, []]));
  for (const library of libraries) {
    const bundle = `${library.name}.xcframework`;
    const bundlePath = join(directory, bundle);
    check('inspection', 'bundle-inventory', { library: library.name });
    assert(lstatSync(bundlePath).isDirectory());
    assert.deepEqual(readdirSync(bundlePath).sort(), [
      'Info.plist',
      ...variants.map(({ id }) => id),
    ]);
    const plistPath = join(bundlePath, 'Info.plist');
    check('inspection', 'info-plist', { library: library.name });
    checkFile(plistPath, sha256, `${bundle}/Info.plist`);
    const plist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plistPath]));
    assert.equal(plist.XCFrameworkFormatVersion, '1.0');
    assert.equal(plist.AvailableLibraries.length, variants.length);
    let previousHeaders;
    for (const variant of sdks) {
      const scope = { sdk: variant.sdk, library: library.name };
      check('inspection', 'slice-metadata', scope);
      const entries = plist.AvailableLibraries.filter(
        (entry) => entry.LibraryIdentifier === variant.id,
      );
      assert.equal(entries.length, 1);
      const [entry] = entries;
      assert.equal(entry.LibraryPath, `${library.name}.a`);
      assert.equal(entry.HeadersPath, 'Headers');
      assert.equal(entry.SupportedPlatform, 'ios');
      assert.equal(
        entry.SupportedPlatformVariant,
        variant.sdk === 'iphonesimulator' ? 'simulator' : undefined,
      );
      assert.deepEqual(entry.SupportedArchitectures, ['arm64']);
      const slice = checkSlice(directory, variant, library, sha256, (control, detail) =>
        check('inspection', control, { ...scope, ...detail }),
      );
      check('inspection', 'matching-headers', scope);
      if (previousHeaders) assert.deepEqual(slice.headerNames, previousHeaders);
      previousHeaders = slice.headerNames;
      slicesById.get(variant.id).push(slice);
    }
  }
  check('inspection', 'license-files');
  for (const name of ['curl-COPYING', 'openssl-LICENSE.txt']) {
    checkFile(join(directory, name), sha256, name);
  }
  const observations = sdks.map((variant) => {
    const slices = slicesById.get(variant.id);
    return {
      sdk: variant.sdk,
      sdkBuild: variant.sdkBuild,
      archives: slices.map(({ library, macho }) => ({ library, ...macho })),
      probes: ['system', 'qualification'].map((mode) =>
        linkProbe(work, variant, slices, mode, (control, detail) =>
          check('link', control, { sdk: variant.sdk, profile: mode, ...detail }),
        ),
      ),
    };
  });
  check('manifest', 'recipe-fingerprints');
  const recipe = Object.fromEntries(
    ['build.mjs', 'link-probe.c', 'tls-profile.h'].map((name) => [
      name,
      fileHash(join(source, name)),
    ]),
  );
  return { profile, recipe, observations, sha256 };
}

function createWorkspace(workRoot, check) {
  check('workspace', 'create');
  process.umask(0o077);
  return mkdtempSync(join(workRoot, 'bunny-apple-xcframework.'));
}

export function verifyXCFrameworks(directory, { workRoot = '/tmp', check = ignoreCheck } = {}) {
  const sdks = selectSDKs(check);
  const work = createWorkspace(workRoot, check);
  check('manifest', 'package-inventory');
  assert.deepEqual(readdirSync(directory).sort(), packageFiles);
  const observed = inspectPackage(directory, work, sdks, check);
  check('manifest', 'match-observed-package');
  const manifest = join(directory, 'manifest.json');
  assert(lstatSync(manifest).isFile());
  assert.deepEqual(
    observed,
    JSON.parse(readFileSync(manifest, 'utf8')),
    'Package and manifest disagree',
  );
  return { manifest: observed, sha256: fileHash(manifest) };
}

export function buildXCFrameworks(paths, { workRoot = '/tmp', check = ignoreCheck } = {}) {
  verifyArchives(paths, check);
  const sdks = selectSDKs(check);
  const work = createWorkspace(workRoot, check);
  const archives = upstream.map(({ archive }, index) => {
    check('archives', 'copy', { archive });
    const path = join(work, archive);
    copyFileSync(paths[index], path);
    return path;
  });
  verifyArchives(archives, check);
  const staging = sdks.map((variant) => buildSlice(work, variant, archives, check));
  check('packaging', 'create-package-directory');
  const directory = join(work, 'package');
  mkdirSync(directory);
  for (const { name } of libraries) {
    check('packaging', 'create-xcframework', { library: name });
    run('xcodebuild', [
      '-create-xcframework',
      ...staging.flatMap((slice) => [
        '-library',
        join(slice, name, `${name}.a`),
        '-headers',
        join(slice, name, 'Headers'),
      ]),
      '-output',
      join(directory, `${name}.xcframework`),
    ]);
  }
  check('packaging', 'copy-licenses');
  const deviceSources = join(work, sdks[0].sdk);
  copyFileSync(
    join(deviceSources, upstream[0].directory, 'COPYING'),
    join(directory, 'curl-COPYING'),
  );
  copyFileSync(
    join(deviceSources, upstream[1].directory, 'LICENSE.txt'),
    join(directory, 'openssl-LICENSE.txt'),
  );
  const report = inspectPackage(directory, work, sdks, check);
  check('manifest', 'write');
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
  return directory;
}

function main([action, ...args]) {
  if (action === 'profile' && args.length === 0) {
    process.stdout.write(JSON.stringify(profile, null, 2) + '\n');
  } else if (action === 'archives' && args.length === 2) {
    verifyArchives(args);
    process.stdout.write('Pinned archive SHA-256 checks passed.\n');
  } else if (action === 'build' && args.length === 2) {
    const directory = buildXCFrameworks(args);
    process.stdout.write(directory + '\n');
  } else if (action === 'verify' && args.length === 1) {
    const { sha256 } = verifyXCFrameworks(resolve(args[0]));
    process.stdout.write(`${sha256}  manifest.json\n`);
  } else {
    throw new Error(
      'Usage: node build.mjs profile | archives CURL OPENSSL | build CURL OPENSSL | verify PACKAGE',
    );
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
