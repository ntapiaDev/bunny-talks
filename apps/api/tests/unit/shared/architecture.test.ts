import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LoginModule } from '../../../src/auth/login/login.module.js';
import { RegistrationModule } from '../../../src/auth/registration/registration.module.js';
import { SessionModule } from '../../../src/auth/sessions/session.module.js';
import { Database } from '../../../src/shared/database/database.js';
import { DatabaseModule } from '../../../src/shared/database/database.module.js';
import { VaultModule } from '../../../src/vault/vault.module.js';

const apiRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = resolve(apiRoot, '../..');

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function imports(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const result: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      result.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) result.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

const sources = [
  ...files(join(apiRoot, 'src')),
  ...['contracts', 'validation', 'crypto/core', 'crypto/backup', 'crypto/engine'].flatMap((name) =>
    files(join(repoRoot, 'packages', name, 'src')),
  ),
  ...files(join(repoRoot, 'apps/mobile/src')),
].filter((path) => /\.tsx?$/.test(path));
const graph = new Map(sources.map((path) => [path, imports(path)]));
const packageEntries = new Map([
  ['@bunny-talks/contracts', 'contracts/src/index.ts'],
  ['@bunny-talks/validation', 'validation/src/index.ts'],
  ['@bunny-talks/crypto-core', 'crypto/core/src/index.ts'],
  ['@bunny-talks/crypto-backup', 'crypto/backup/src/index.ts'],
  ['@bunny-talks/crypto-backup/experimental', 'crypto/backup/src/experimental.ts'],
  ['@bunny-talks/crypto-engine', 'crypto/engine/src/index.ts'],
]);

function localTarget(path: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const candidate = resolve(dirname(path), specifier);
    return [
      candidate,
      candidate.replace(/\.js$/, '.ts'),
      `${candidate}.ts`,
      `${candidate}.tsx`,
    ].find((entry) => graph.has(entry));
  }
  const entry = packageEntries.get(specifier);
  return entry ? join(repoRoot, 'packages', entry) : undefined;
}

describe('architectural dependency boundaries', () => {
  it('keeps the local source graph acyclic, including type imports and package entrypoints', () => {
    const complete = new Set<string>();
    function visit(path: string, stack: string[]): void {
      expect(stack, relative(repoRoot, path)).not.toContain(path);
      if (complete.has(path)) return;
      for (const specifier of graph.get(path) ?? []) {
        const target = localTarget(path, specifier);
        if (target) visit(target, [...stack, path]);
      }
      complete.add(path);
    }
    for (const path of graph.keys()) visit(path, []);
  });

  it('keeps reusable packages independent of application frameworks and persistence', () => {
    for (const [path, dependencies] of graph) {
      if (!path.startsWith(join(repoRoot, 'packages') + '/')) continue;
      for (const dependency of dependencies) {
        expect(dependency, relative(repoRoot, path)).not.toMatch(
          /^(?:@nestjs\/|express$|@prisma\/|pg$|react(?:-native)?$|expo(?:-|$))/,
        );
        expect(localTarget(path, dependency) ?? '').not.toContain('/apps/');
      }
      if (path.includes('/crypto/core/src/'))
        expect(dependencies.every((dependency) => dependency.startsWith('.'))).toBe(true);
    }
  });

  it('keeps pure backend rules independent of Nest, Prisma and PostgreSQL repositories', () => {
    const pureFiles = [
      'auth/password-verifier.ts',
      'auth/verified-login.ts',
      'auth/authentication-error.ts',
      'auth/registration/registration-policy.ts',
      'auth/reauthentication/reauthentication-intent.ts',
      'auth/sessions/session-token.ts',
      'auth/sessions/session-lifecycle.ts',
      'vault/prepared-password-change.ts',
      'vault/publication-digest.ts',
      'vault/vault-request-fingerprint.ts',
    ];
    for (const file of pureFiles) {
      for (const dependency of graph.get(join(apiRoot, 'src', file)) ?? []) {
        expect(dependency, file).not.toMatch(/@nestjs|express|prisma|postgres-|\/http\//);
      }
    }
  });

  it('keeps controllers away from database clients and privileged repositories', () => {
    for (const [path, dependencies] of graph) {
      if (!path.endsWith('.controller.ts')) continue;
      expect(dependencies.join('\n')).not.toMatch(/prisma|postgres-|\/database[/.]/);
      expect(dependencies.join('\n')).not.toMatch(/verified-login/);
    }
    for (const [path, dependencies] of graph) {
      if (path.startsWith(join(apiRoot, 'src/shared/database') + '/'))
        expect(dependencies.join('\n')).not.toMatch(/\/auth\/|\/config\.js|\/http\//);
    }
  });

  it('keeps session repositories independent of login orchestration and policy', () => {
    for (const [path, dependencies] of graph) {
      if (!path.startsWith(join(apiRoot, 'src/auth/sessions') + '/')) continue;
      for (const dependency of dependencies) {
        const target = localTarget(path, dependency);
        expect(target ?? dependency).not.toContain('/auth/login/');
      }
    }
    for (const file of ['auth/verified-login.ts', 'auth/authentication-error.ts']) {
      const dependencies = graph.get(join(apiRoot, 'src', file));
      expect(dependencies).toBeDefined();
      for (const dependency of dependencies!)
        expect(localTarget(join(apiRoot, 'src', file), dependency) ?? dependency).not.toMatch(
          /\/auth\/(?:login|sessions)\//,
        );
    }
  });

  it('keeps vault independent of HTTP login and session module composition', () => {
    for (const [path, dependencies] of graph) {
      if (!path.startsWith(join(apiRoot, 'src/vault') + '/')) continue;
      expect(dependencies.join('\n')).not.toMatch(/auth\/login\/|session\.module/);
    }
  });

  it('composes one explicit database module and exports only session HTTP capabilities', () => {
    const database = DatabaseModule.register('postgresql://fixture:fixture@127.0.0.1/test');
    const session = SessionModule.register(database);
    expect(session.imports).toEqual([database]);
    expect(database.exports).toEqual([Database]);
    expect(session.exports).not.toContain(Database);
    expect(session.providers).not.toContainEqual(expect.objectContaining({ provide: Database }));
    const login = LoginModule.register(database);
    expect(login.imports).toEqual([database]);
    expect(login.exports).toEqual([]);
    expect(login.providers).not.toContainEqual(expect.objectContaining({ provide: Database }));
    const registration = RegistrationModule.register(database);
    expect(registration.imports).toEqual([database]);
    expect(registration.exports).toEqual([]);
    expect(registration.providers).not.toContainEqual(
      expect.objectContaining({ provide: Database }),
    );
    const vault = VaultModule.register(database);
    expect(vault.imports).toEqual([database]);
    expect(vault.exports).toEqual([]);
    expect(vault.providers).not.toContainEqual(expect.objectContaining({ provide: Database }));
  });

  it('assigns every API test file to exactly one pnpm suite', () => {
    const { scripts } = JSON.parse(readFileSync(join(apiRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const suites = ['test', 'test:persistence', 'test:http'].map((name) => {
      const command = scripts[name]!;
      return command.slice(command.indexOf('vitest run ') + 'vitest run '.length).split(/\s+/);
    });
    const tests = files(join(apiRoot, 'tests')).filter((path) =>
      /\.test\.[cm]?[jt]sx?$/.test(path),
    );
    for (const path of tests) {
      const file = relative(apiRoot, path);
      expect(
        suites.filter((filters) => filters.some((filter) => file.startsWith(filter))),
        file,
      ).toHaveLength(1);
    }
  });
});
