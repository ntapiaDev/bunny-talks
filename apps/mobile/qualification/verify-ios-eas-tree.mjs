import process from 'node:process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { error as reportError } from 'node:console';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';

function inventory(directory, localDependencies = false) {
  const root = resolve(directory);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory())
    throw new Error('Expected a real workspace directory');
  const paths = new Map();
  function walk(relative = '') {
    for (const name of readdirSync(join(root, relative))) {
      const path = relative ? relative + '/' + name : name;
      const entry = lstatSync(join(root, path));
      if (name === 'node_modules') {
        if (localDependencies && entry.isDirectory()) continue;
        throw new Error('Unexpected node_modules in the qualification tree');
      }
      if (entry.isDirectory()) {
        paths.set(path, { type: 'directory' });
        walk(path);
      } else if (entry.isFile()) {
        paths.set(path, { type: 'file', size: entry.size });
      } else {
        throw new Error('Symbolic links and special files are refused');
      }
    }
  }
  walk();
  return { root, paths };
}

const appConfig = 'apps/mobile/app.json';

function identical(expected, actual, allowProjectLink = false) {
  if (expected.paths.size !== actual.paths.size)
    throw new Error('Qualification tree has missing or unexpected paths');
  for (const [path, entry] of expected.paths) {
    const candidateEntry = actual.paths.get(path);
    if (candidateEntry?.type !== entry.type) throw new Error(`Qualification path differs: ${path}`);
    if (entry.type !== 'file') continue;
    const linkedAppConfig = allowProjectLink && path === appConfig;
    if (linkedAppConfig ? candidateEntry.size > 64 * 1024 : candidateEntry.size !== entry.size)
      throw new Error(`Qualification file size differs: ${path}`);
    const original = readFileSync(join(expected.root, path));
    const candidate = readFileSync(join(actual.root, path));
    if (linkedAppConfig) {
      let staged;
      try {
        staged = JSON.parse(candidate);
      } catch {
        throw new Error('Invalid linked app.json');
      }
      const { expo } = staged;
      delete expo.owner;
      // Only the explicit project link and the account owner may be written by EAS init.
      if (expo.extra?.eas) {
        delete expo.extra.eas.projectId;
        if (!Object.keys(expo.extra.eas).length) delete expo.extra.eas;
        if (!Object.keys(expo.extra).length) delete expo.extra;
      }
      if (!isDeepStrictEqual(JSON.parse(original), staged))
        throw new Error('Linked app.json differs from the generated app configuration');
      continue;
    }
    if (!original.equals(candidate)) throw new Error(`Qualification file differs: ${path}`);
  }
}

try {
  const [reference, stage, archive] = process.argv.slice(2);
  const prepared = inventory(stage, true);
  identical(inventory(reference), prepared, true);
  if (archive) {
    const inspected = inventory(archive);
    if (inspected.root === prepared.root)
      throw new Error('The inspected archive must be separate from the workspace');
    identical(prepared, inspected);
  }
} catch (error) {
  reportError(error instanceof Error ? error.message : 'Qualification tree check failed');
  process.exitCode = 1;
}
