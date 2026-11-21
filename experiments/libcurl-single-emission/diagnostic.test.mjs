import { deepEqual, equal, match } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const script = readFileSync(new URL('./run-github-actions.sh', import.meta.url), 'utf8');
const handlers = script.slice(
  script.indexOf('current_stage=initialization'),
  script.indexOf('stage platform'),
);
const build = readFileSync(new URL('./build-apple.sh', import.meta.url), 'utf8');
const inspection = build.slice(
  build.indexOf('inspect_macho()'),
  build.indexOf('\n\n', build.indexOf('inspect_macho macho-dynamic-libraries')),
);
const sourceDir = fileURLToPath(new URL('.', import.meta.url));
const simulatorVersion = `Load command 12
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform IOSSIMULATOR
    minos 26.5
      sdk 26.5.0
   ntools 1
     tool LD
  version 1234.0
`;
const privateHeader = '/private/test-path/SingleEmission:\n';
const libraryLine = (path) => `\t${path} (compatibility version 1.0.0, current version 1.0.0)\n`;
const foundation = '/System/Library/Frameworks/Foundation.framework/Foundation';
const uiKit = '/System/Library/Frameworks/UIKit.framework/UIKit';
const coreFoundation = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation';
const existingLibraries = [
  foundation,
  uiKit,
  '/usr/lib/libSystem.B.dylib',
  '/usr/lib/libobjc.A.dylib',
];

function runMachoFixture(dir, fixtures, toolFailure) {
  for (const [tool, output] of Object.entries(fixtures)) {
    writeFileSync(join(dir, tool), output);
  }
  const shell = `
set -euo pipefail
work="$1"
proof="$1"
build_dir="$1"
BUNNY_LIBCURL_TMPDIR="$1"
source_dir="$2"
executable=SingleEmission
tool_failure="$3"
phase() { printf '%s\\n' "$1" > "$work/build-phase"; }
xcrun() {
  if [[ "$1" == "$tool_failure" ]]; then return 17; fi
  cat "$work/$1"
}
${handlers}
stage build test
(
${inspection}
)
`;
  return spawnSync('bash', ['-c', shell, 'test', dir, sourceDir, toolFailure ?? '']);
}

test('Mach-O tool fixtures traverse the build checks and retain only bounded observations', () => {
  const allLibraries = [...existingLibraries, coreFoundation];
  const valid = {
    lipo: 'arm64\n',
    vtool: simulatorVersion,
    otool: privateHeader + allLibraries.map(libraryLine).join(''),
  };
  const wrongCoreFoundationPaths = [
    coreFoundation.replace(/CoreFoundation$/, 'Versions/A/CoreFoundation'),
    '/private/test-path/CoreFoundation',
    '@rpath/CoreFoundation.framework/CoreFoundation',
  ];
  const unknownFramework = libraryLine(
    '/System/Library/Frameworks/SystemConfiguration.framework/SystemConfiguration',
  );
  const mixedRejections =
    libraryLine(wrongCoreFoundationPaths[0]) +
    libraryLine(foundation) +
    libraryLine('@rpath/libssl.3.dylib') +
    libraryLine('/private/test-path/secret-token.dylib');
  const mixedObservations = [
    { kind: 'system-framework', name: 'CoreFoundation' },
    { kind: 'dyld-relative', name: 'libssl.3.dylib' },
    { kind: 'other-path', name: 'other' },
  ];
  const cases = [
    { overrides: {}, exit: 0, allowed: allLibraries },
    {
      overrides: { otool: privateHeader + existingLibraries.map(libraryLine).join('') },
      exit: 0,
      allowed: existingLibraries,
    },
    {
      overrides: { lipo: 'arm64 x86_64 secret-token\n' },
      phase: 'macho-architecture',
      check: 'architecture-mismatch',
    },
    {
      overrides: { vtool: simulatorVersion.replace('IOSSIMULATOR', 'IOS') },
      phase: 'macho-build-version',
      check: 'build-version-mismatch',
    },
    {
      overrides: { vtool: simulatorVersion.replace('26.5.0', '26.5.1') },
      phase: 'macho-build-version',
      check: 'build-version-mismatch',
    },
    {
      overrides: { vtool: simulatorVersion.replace('minos 26.5', 'minos 26.4') },
      phase: 'macho-build-version',
      check: 'build-version-mismatch',
    },
    {
      overrides: { vtool: simulatorVersion.replace('sdk 26.5.0', 'sdk n/a') },
      phase: 'macho-build-version',
      check: 'build-version-malformed',
    },
    {
      overrides: { vtool: simulatorVersion.replace('LC_BUILD_VERSION', 'LC_VERSION_MIN_IPHONEOS') },
      phase: 'macho-build-version',
      check: 'build-version-missing',
    },
    {
      overrides: { vtool: simulatorVersion + simulatorVersion },
      phase: 'macho-build-version',
      check: 'multiple-version-commands',
    },
    {
      overrides: { otool: privateHeader },
      phase: 'macho-dynamic-libraries',
      check: 'dependency-list-empty',
    },
    {
      overrides: { otool: privateHeader + libraryLine(foundation.replace(/Foundation$/, 'UIKit')) },
      phase: 'macho-dynamic-libraries',
      check: 'unexpected-dynamic-library',
    },
    {
      overrides: { otool: privateHeader + libraryLine('/private/test-path/secret-token.dylib') },
      phase: 'macho-dynamic-libraries',
      check: 'unexpected-dynamic-library',
      libraries: [{ kind: 'other-path', name: 'other' }],
    },
    {
      overrides: { otool: privateHeader + libraryLine('@rpath/libssl.3.dylib') },
      phase: 'macho-dynamic-libraries',
      check: 'unexpected-dynamic-library',
      libraries: [{ kind: 'dyld-relative', name: 'libssl.3.dylib' }],
    },
    {
      overrides: { otool: privateHeader + wrongCoreFoundationPaths.map(libraryLine).join('') },
      phase: 'macho-dynamic-libraries',
      check: 'unexpected-dynamic-library',
      libraries: [
        { kind: 'system-framework', name: 'CoreFoundation' },
        { kind: 'other-path', name: 'CoreFoundation' },
        { kind: 'dyld-relative', name: 'CoreFoundation' },
      ],
    },
    {
      overrides: { otool: privateHeader + mixedRejections },
      phase: 'macho-dynamic-libraries',
      check: 'unexpected-dynamic-library',
      libraries: mixedObservations,
    },
    {
      overrides: { otool: privateHeader + unknownFramework.repeat(7) + mixedRejections },
      phase: 'macho-dynamic-libraries',
      check: 'unexpected-dynamic-library',
      libraries: Array(6).fill({ kind: 'system-framework', name: 'SystemConfiguration' }),
      unexpectedCount: 10,
    },
    {
      overrides: {
        otool: privateHeader + '\tsecret-token\n' + mixedRejections + '\tbad private line\n',
      },
      phase: 'macho-dynamic-libraries',
      check: 'dependency-list-malformed',
      libraries: mixedObservations,
      malformedCount: 2,
    },
    {
      overrides: { otool: privateHeader + '\tsecret-token\n' },
      phase: 'macho-dynamic-libraries',
      check: 'dependency-list-malformed',
    },
    { overrides: {}, tool: 'vtool', phase: 'macho-build-version', exit: 17 },
  ];

  for (const entry of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'bunny-macho-test-'));
    try {
      const result = runMachoFixture(dir, { ...valid, ...entry.overrides }, entry.tool);
      equal(result.status, entry.exit ?? 1, result.stderr?.toString());
      if (entry.exit === 0) {
        equal(
          readFileSync(join(dir, 'macho-libraries.txt'), 'utf8'),
          entry.allowed.join('\n') + '\n',
        );
        continue;
      }
      const report = readFileSync(join(dir, 'report.json'), 'utf8');
      equal(report.includes('secret-token'), false);
      equal(report.includes('/private'), false);
      const parsed = JSON.parse(report);
      equal(parsed.verdict, 'NOT_RUN');
      equal(parsed.diagnostic.subphase, entry.phase);
      equal(parsed.diagnostic.exitCode, entry.exit ?? 1);
      equal(parsed.diagnostic.observation?.check, entry.check);
      if (entry.libraries) {
        const unexpectedCount = entry.unexpectedCount ?? entry.libraries.length;
        deepEqual(parsed.diagnostic.observation, {
          check: entry.check,
          observed: entry.libraries,
          unexpectedCount,
          malformedCount: entry.malformedCount ?? 0,
          truncated: unexpectedCount > entry.libraries.length,
        });
      }
      if (entry.phase === 'macho-dynamic-libraries') {
        equal(readFileSync(join(dir, 'macho-libraries.txt'), 'utf8'), '');
      }
      if (entry.phase === 'macho-architecture') {
        equal(parsed.diagnostic.observation.expected, 'arm64');
        deepEqual(parsed.diagnostic.observation.observed, ['arm64', 'x86_64', 'other']);
      }
      if (entry.overrides.vtool?.includes('26.5.1')) {
        deepEqual(parsed.diagnostic.observation.expected, {
          platform: 'IOSSIMULATOR',
          minos: '26.5',
          sdk: '26.5',
        });
        deepEqual(parsed.diagnostic.observation.observed, {
          platform: 'IOSSIMULATOR',
          minos: '26.5',
          sdk: '26.5.1',
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('technical failures retain bounded phase and exit code without copying logs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bunny-diagnostic-test-'));
  try {
    const cases = [
      ['build', 'openssl-configure', 17, 'openssl-configure'],
      ['build', 'curl-compile', 2, 'curl-compile'],
      ['build', 'app-link', 1, 'app-link'],
      ['build', '/private/secret', 42, 'unknown'],
      ['runtime', 'curl-compile', 7, 'none'],
    ];
    for (const [stage, phase, code, expected] of cases) {
      writeFileSync(join(dir, 'build-phase'), phase);
      writeFileSync(join(dir, 'technical.log'), 'private-token /private/path');
      const shell = `set -e\nwork="$1"\nproof="$1"\n${handlers}\nstage "$2" test\nbash -c "exit $3"\n`;
      const result = spawnSync('bash', ['-c', shell, 'test', dir, stage, String(code)]);
      equal(result.status, code);
      const report = readFileSync(join(dir, 'report.json'), 'utf8');
      deepEqual(JSON.parse(report).diagnostic, {
        stage,
        subphase: expected,
        category: 'command-failed',
        exitCode: code,
      });
      equal(report.includes('private'), false);
      match(readFileSync(join(dir, 'summary.md'), 'utf8'), /Échec technique/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('functional FAIL survives the terminal exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bunny-diagnostic-test-'));
  try {
    const shell = `set -e\nwork="$1"\nproof="$1"\n${handlers}\nstage campaign-report test\nprintf '%s' '{"verdict":"FAIL","reason":"guard-bypassed"}' > "$proof/report.json"\ntrap - ERR\nexit 1\n`;
    const result = spawnSync('bash', ['-c', shell, 'test', dir]);
    equal(result.status, 1);
    equal(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).verdict, 'FAIL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
