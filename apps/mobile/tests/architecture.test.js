import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
const mobile = path.resolve(import.meta.dirname, '..');
const repository = path.resolve(mobile, '../..');
const qualification = path.join(mobile, 'qualification');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? files(name) : /\.[cm]?tsx?$/.test(name) ? [name] : [];
  });
}
function imports(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const result = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      result.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      result.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}
describe('mobile architecture boundaries', () => {
  it('keeps the diagnostic presentation independent of storage, crypto and scenarios', () => {
    const screen = path.join(mobile, 'qualification/crypto/diagnostics/DiagnosticsScreen.tsx');
    expect(imports(screen).sort()).toEqual(['./diagnostic-entry', 'react', 'react-native']);
  });
  it('keeps shared packages independent of mobile in source and manifests', () => {
    const packages = path.join(repository, 'packages');
    for (const file of files(packages)) {
      for (const specifier of imports(file)) {
        expect(specifier, file).not.toMatch(/^@bunny-talks\/mobile(?:\/|$)/);
        if (specifier.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), specifier);
          expect(resolved.startsWith(mobile + path.sep), file).toBe(false);
        }
      }
    }
    function checkManifests(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const name = path.join(directory, entry.name);
        if (entry.isDirectory()) checkManifests(name);
        else if (entry.name === 'package.json') {
          const manifest = JSON.parse(readFileSync(name, 'utf8'));
          for (const key of [
            'dependencies',
            'devDependencies',
            'peerDependencies',
            'optionalDependencies',
          ]) {
            expect(manifest[key] ?? {}, name).not.toHaveProperty('@bunny-talks/mobile');
          }
        }
      }
    }
    checkManifests(packages);
  });
  it('installs native randomness before loading the application', () => {
    const entry = path.join(mobile, 'index.ts');
    expect(imports(entry)).toEqual([
      './src/infrastructure/crypto/random-provider',
      'expo',
      './src/product/App',
    ]);
  });
  it('keeps qualification code outside the application import graph', () => {
    for (const file of [path.join(mobile, 'index.ts'), ...files(path.join(mobile, 'src'))]) {
      for (const specifier of imports(file)) {
        if (!specifier.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        expect(resolved, file).not.toBe(qualification);
        expect(resolved.startsWith(qualification + path.sep), file).toBe(false);
      }
    }
    const experimental = [
      '@open-e2ee/signal-protocol-sdk',
      'account-vault-v1.json',
      'key-envelope-recovery.json',
      'native-vault-v1.json',
    ];
    const sources = new Map(
      files(path.join(mobile, 'src')).map((file) => [file.replace(/\.[^.]+$/, ''), file]),
    );
    const visited = new Set();
    function visitProduct(file) {
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      for (const marker of experimental) expect(source, file).not.toContain(marker);
      expect(path.basename(file), file).not.toMatch(
        /^(local-crypto-initialization|expo-local-store)\.ts$/,
      );
      for (const specifier of imports(file)) {
        if (!specifier.startsWith('.')) continue;
        const stem = path.resolve(path.dirname(file), specifier).replace(/\.[cm]?tsx?$/, '');
        const target = sources.get(stem);
        if (target) visitProduct(target);
      }
    }
    visitProduct(path.join(mobile, 'index.ts'));
  });
  it('exposes diagnostics only through the crypto qualification entry', () => {
    const entry = path.join(qualification, 'crypto/entry.tsx');
    expect(imports(entry)).toEqual([
      '../../src/infrastructure/crypto/random-provider',
      'expo',
      './composition/App',
    ]);
    expect(imports(path.join(qualification, 'crypto/composition/App.tsx'))).toContain(
      '../diagnostics/diagnostics',
    );
  });
  it('has no cycles among mobile source imports', () => {
    const sourceFiles = files(path.join(mobile, 'src'));
    const byStem = new Map(sourceFiles.map((file) => [file.replace(/\.[^.]+$/, ''), file]));
    const visited = new Set();
    const active = new Set();
    function visit(file) {
      expect(active.has(file), `Import cycle at ${path.relative(mobile, file)}`).toBe(false);
      if (visited.has(file)) return;
      active.add(file);
      for (const specifier of imports(file)) {
        if (!specifier.startsWith('.')) continue;
        const target = byStem.get(
          path.resolve(path.dirname(file), specifier).replace(/\.[cm]?[jt]sx?$/, ''),
        );
        if (target) visit(target);
      }
      active.delete(file);
      visited.add(file);
    }
    sourceFiles.forEach(visit);
  });
});
