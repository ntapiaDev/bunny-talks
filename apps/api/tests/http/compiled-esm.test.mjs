import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'vitest';

const apiRoot = new URL('../../', import.meta.url);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test('emits only current production sources and imports every module with Node ESM', () => {
  const sourceRoot = new URL('src/', apiRoot);
  const outputRoot = new URL('dist/src/', apiRoot);
  const expected = files(sourceRoot).map((file) =>
    file.href.slice(sourceRoot.href.length).replace(/\.ts$/, ''),
  );
  const actual = files(outputRoot).map((file) => file.href.slice(outputRoot.href.length));
  assert.deepEqual(
    actual.sort(),
    expected.flatMap((file) => [`${file}.js`, `${file}.d.ts`]).sort(),
  );
  assert.ok(existsSync(new URL('dist/generated/prisma/client.js', apiRoot)));
  assert.equal(existsSync(new URL('dist/tests', apiRoot)), false);
  const modules = files(outputRoot).filter((file) => file.pathname.endsWith('.js'));
  const output = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `
    await import('reflect-metadata');
    for (const path of process.argv.slice(1)) await import(path);
    process.stdout.write('ESM imports verified\\n');
  `,
      ...modules.map((file) => file.href),
    ],
    {
      cwd: fileURLToPath(apiRoot),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(output, 'ESM imports verified\n');
});

test('rejects forged password proofs in plain compiled JavaScript before any database access', () => {
  const output = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { randomUUID } from 'node:crypto';
    import { AuthenticationError } from './dist/src/auth/authentication-error.js';
    import { createPasswordVerifier } from './dist/src/auth/password-verifier.js';
    import { PostgresSessionRepository } from './dist/src/auth/sessions/postgres-session-repository.js';
    import { requireVerifiedLogin, VerifiedLogin } from './dist/src/auth/verified-login.js';

    const password = 'compiled runtime proof password';
    const credential = { accountId: 'compiled-account-a', canonical: 'a@example.com',
      verifiedAtMs: 1, revision: 1n, verifierUpdatedAtMs: 1,
      verifier: await createPasswordVerifier(password) };
    assert.equal(await VerifiedLogin.verify('incorrect', credential), undefined);
    const proof = await VerifiedLogin.verify(password, credential);
    assert.ok(proof && Object.isFrozen(proof) && Object.isFrozen(requireVerifiedLogin(proof)));
    const accountB = { ...credential, accountId: 'compiled-account-b' };
    credential.accountId = accountB.accountId;
    assert.ok(requireVerifiedLogin(proof).accountId === 'compiled-account-a');
    assert.equal(Reflect.defineProperty(proof, 'credential', { value: accountB }), false);
    assert.throws(() => Object.setPrototypeOf(proof, { credential: accountB }), TypeError);
    let queries = 0;
    const repository = new PostgresSessionRepository({ $transaction() { queries++; throw new Error('unexpected database access'); } });
    const forgeries = [
      { credential: accountB },
      Object.create(VerifiedLogin.prototype, { credential: { value: accountB } }),
      new VerifiedLogin(accountB),
      new (class extends VerifiedLogin {})(accountB),
      Object.setPrototypeOf({ credential: accountB }, VerifiedLogin.prototype),
      Object.create(proof, { credential: { value: accountB } }),
      new Proxy(proof, { get() { throw new Error('must not read attacker properties'); } }),
    ];
    for (const forged of forgeries) {
      assert.throws(() => requireVerifiedLogin(forged), (error) => error instanceof AuthenticationError && error.code === 'INVALID_CREDENTIALS');
      await assert.rejects(repository.createAfterLogin(forged, randomUUID(), 1000),
        (error) => error instanceof AuthenticationError && error.code === 'INVALID_CREDENTIALS');
    }
    assert.equal(queries, 0);
    assert.ok(requireVerifiedLogin(proof).accountId === 'compiled-account-a');
    process.stdout.write('Runtime password proofs verified\\n');
  `,
    ],
    { cwd: fileURLToPath(apiRoot), encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(output, 'Runtime password proofs verified\n');
});
