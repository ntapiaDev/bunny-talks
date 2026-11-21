import { readFileSync, statSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const architecture = 'arm64';
const platform = 'IOSSIMULATOR';
const version = '26.5';
const allowedLibraries = new Set([
  '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation',
  '/System/Library/Frameworks/Foundation.framework/Foundation',
  '/System/Library/Frameworks/UIKit.framework/UIKit',
  '/usr/lib/libSystem.B.dylib',
  '/usr/lib/libobjc.A.dylib',
]);

// Keep the full observation within the CI report reader's 512-byte limit.
const maxReportedLibraries = 6;

const knownArchitectures = new Set(['arm64', 'arm64e', 'x86_64', 'x86_64h']);
const knownPlatforms = new Set(['IOSSIMULATOR', 'IOS', 'MACOS', 'MACCATALYST']);
const knownLibraryNames = new Set([
  'CFNetwork',
  'CoreFoundation',
  'Foundation',
  'Security',
  'SystemConfiguration',
  'UIKit',
  'libSystem.B.dylib',
  'libobjc.A.dylib',
  'libc++.1.dylib',
  'libresolv.9.dylib',
  'libz.1.dylib',
  'libcurl.dylib',
  'libcurl.4.dylib',
  'libssl.dylib',
  'libssl.3.dylib',
  'libcrypto.dylib',
  'libcrypto.3.dylib',
]);

function checkArchitecture(output) {
  const fields = output.trim().split(/\s+/).filter(Boolean);
  if (fields.length === 1 && fields[0] === architecture) return {};

  return {
    check: 'architecture-mismatch',
    expected: architecture,
    observed: fields.slice(0, 4).map((field) => (knownArchitectures.has(field) ? field : 'other')),
    additionalArchitectures: fields.length > 4,
  };
}

function checkBuildVersion(output) {
  const expected = { platform, minos: version, sdk: version };
  // vtool also prints legacy version commands. Read all three fields from the same command.
  const commands = output.split(/^Load command \d+[ \t]*\r?$/m).slice(1);
  const buildCommands = commands.filter((command) =>
    /^\s*cmd\s+LC_BUILD_VERSION\s*$/m.test(command),
  );
  if (buildCommands.length !== 1 || commands.length !== 1) {
    return {
      check: buildCommands.length === 0 ? 'build-version-missing' : 'multiple-version-commands',
      expected,
    };
  }

  const [command] = buildCommands;
  const fields = Object.fromEntries(
    Object.keys(expected).map((name) => {
      const matches = [...command.matchAll(new RegExp(`^\\s*${name}[ \\t]+(\\S+)[ \\t]*$`, 'gm'))];
      return [name, matches.length === 1 ? matches[0][1] : null];
    }),
  );
  const observed = {
    platform: knownPlatforms.has(fields.platform)
      ? fields.platform
      : fields.platform
        ? 'other'
        : null,
    minos: /^\d{1,5}\.\d{1,3}(\.\d{1,3})?$/.test(fields.minos ?? '') ? fields.minos : null,
    sdk: /^\d{1,5}\.\d{1,3}(\.\d{1,3})?$/.test(fields.sdk ?? '') ? fields.sdk : null,
  };
  if (command.includes('Incorrect size') || Object.values(observed).includes(null)) {
    return { check: 'build-version-malformed', expected, observed };
  }
  const versionMatches = (value) => value === version || value === version + '.0';
  if (
    fields.platform !== platform ||
    !versionMatches(fields.minos) ||
    !versionMatches(fields.sdk)
  ) {
    return { check: 'build-version-mismatch', expected, observed };
  }
  return {};
}

function describeLibrary(path) {
  const basename = path.split('/').at(-1);
  let kind = 'other-path';
  if (path.startsWith('/System/Library/Frameworks/')) kind = 'system-framework';
  else if (path.startsWith('/usr/lib/')) kind = 'system-library';
  else if (path.startsWith('@')) kind = 'dyld-relative';
  return { kind, name: knownLibraryNames.has(basename) ? basename : 'other' };
}

function checkDynamicLibraries(output) {
  const [header, ...entries] = output.trimEnd().split(/\r?\n/);
  if (!/^\S.*:$/.test(header)) return { check: 'dependency-list-malformed' };
  if (entries.length === 0) return { check: 'dependency-list-empty' };
  const libraries = [];
  const observed = [];
  let unexpectedCount = 0;
  let malformedCount = 0;
  for (const entry of entries) {
    const match =
      /^[ \t]+(.+?) \(compatibility version \d+\.\d+\.\d+, current version \d+\.\d+\.\d+(?:, (?:weak|reexport|upward|lazy))*\)$/.exec(
        entry,
      );
    if (!match) {
      malformedCount++;
    } else if (allowedLibraries.has(match[1])) {
      libraries.push(match[1]);
    } else {
      unexpectedCount++;
      if (observed.length < maxReportedLibraries) observed.push(describeLibrary(match[1]));
    }
  }
  if (malformedCount || unexpectedCount) {
    return {
      check: malformedCount ? 'dependency-list-malformed' : 'unexpected-dynamic-library',
      observed,
      unexpectedCount,
      malformedCount,
      truncated: unexpectedCount > observed.length,
    };
  }
  return { libraries };
}

const inspections = {
  'macho-architecture': checkArchitecture,
  'macho-build-version': checkBuildVersion,
  'macho-dynamic-libraries': checkDynamicLibraries,
};

if (import.meta.main) {
  const [phase, inputPath, diagnosticPath] = process.argv.slice(2);
  const result =
    statSync(inputPath).size > 16 * 1024
      ? { check: 'tool-output-too-large' }
      : inspections[phase](readFileSync(inputPath, 'utf8'));
  if (result.check) {
    writeFileSync(diagnosticPath, JSON.stringify(result) + '\n', { mode: 0o600 });
    process.exitCode = 1;
  } else if (result.libraries) {
    process.stdout.write(result.libraries.join('\n') + '\n');
  }
}
