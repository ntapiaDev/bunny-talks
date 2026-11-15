import { describe, expect, it } from 'vitest';
import {
  classifyVaultOperationReplay,
  evaluateInitialVaultPublication,
  evaluatePasswordVaultTransition,
} from '../src/index.js';
import vector from './fixtures/account-vault-v1.json' with { type: 'json' };
const bytes = (s: string) => new TextEncoder().encode(s);
const cas = { storageRevision: '1', credentialRevision: '1' };
const original = bytes(vector.publication);
function next() {
  const v = JSON.parse(vector.publication) as {
    manifest: { generation: number };
    passwordEnvelope: string;
    content: string;
    recoveryEnvelope: string;
  };
  v.manifest.generation++;
  const p = JSON.parse(v.passwordEnvelope) as { header: { revision: number } };
  p.header.revision++;
  v.passwordEnvelope = JSON.stringify(p);
  return v;
}
const candidate = () => bytes(JSON.stringify(next()));
describe('vault publication transitions', () => {
  it('accepts initial structure only and refuses replacement, stale and invalid contexts', () => {
    expect(
      evaluateInitialVaultPublication(original, vector.context, false, null, '1', '1'),
    ).toEqual({ ok: true, status: 'structural-only-unauthenticated' });
    expect(
      evaluateInitialVaultPublication(original, vector.context, true, null, '1', '1'),
    ).toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(
      evaluateInitialVaultPublication(original, vector.context, false, null, '1', '2'),
    ).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      evaluateInitialVaultPublication(
        original,
        { ...vector.context, account: 'other' },
        false,
        null,
        '1',
        '1',
      ),
    ).toMatchObject({ code: 'INVALID_PUBLICATION' });
    expect(
      evaluateInitialVaultPublication(
        bytes(vector.publication + ' '),
        vector.context,
        false,
        null,
        '1',
        '1',
      ),
    ).toMatchObject({ code: 'INVALID_PUBLICATION' });
    expect(
      evaluateInitialVaultPublication(
        new Uint8Array(131073),
        vector.context,
        false,
        null,
        '1',
        '1',
      ),
    ).toMatchObject({ code: 'INVALID_PUBLICATION' });
  });
  it('accepts only the ordinary password transition, with exact opaque content preservation', () => {
    expect(
      evaluatePasswordVaultTransition(original, candidate(), vector.context, cas, cas),
    ).toEqual({ ok: true, status: 'structural-only-unauthenticated' });
    const v = next();
    v.content = JSON.stringify({
      ...JSON.parse(v.content),
      ciphertext: JSON.parse(v.content).ciphertext.replace(/^./, 'A'),
    });
    expect(
      evaluatePasswordVaultTransition(original, bytes(JSON.stringify(v)), vector.context, cas, cas)
        .ok,
    ).toBe(false);
    const r = next();
    const obj = JSON.parse(r.recoveryEnvelope);
    obj.header.nonce = 'A'.repeat(32);
    r.recoveryEnvelope = JSON.stringify(obj);
    expect(
      evaluatePasswordVaultTransition(original, bytes(JSON.stringify(r)), vector.context, cas, cas)
        .ok,
    ).toBe(false);
    expect(
      evaluatePasswordVaultTransition(original, original, vector.context, cas, cas),
    ).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(
      evaluatePasswordVaultTransition(original, candidate(), vector.context, cas, {
        ...cas,
        storageRevision: '2',
      }),
    ).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      evaluatePasswordVaultTransition(
        original,
        candidate(),
        vector.context,
        { ...cas, storageRevision: '01' },
        cas,
      ),
    ).toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      evaluatePasswordVaultTransition(
        original,
        candidate(),
        vector.context,
        { ...cas, storageRevision: '9223372036854775807' },
        { ...cas, storageRevision: '9223372036854775807' },
      ),
    ).toMatchObject({ code: 'INVALID_TRANSITION' });
  });
  it('rejects unknown cryptographic versions, vault substitution and inconsistent counters', () => {
    const v = next();
    const invalidVersion = JSON.parse(JSON.stringify(v)) as typeof v & {
      header: { version: number };
    };
    invalidVersion.header.version = 2;
    expect(
      evaluatePasswordVaultTransition(
        original,
        bytes(JSON.stringify(invalidVersion)),
        vector.context,
        cas,
        cas,
      ),
    ).toMatchObject({ code: 'INVALID_PUBLICATION' });
    expect(
      evaluatePasswordVaultTransition(
        original,
        candidate(),
        { ...vector.context, vaultId: 'AAAAAAAAAAAAAAAAAAAAAA' },
        cas,
        cas,
      ),
    ).toMatchObject({ code: 'INVALID_PUBLICATION' });
    v.manifest.generation++;
    expect(
      evaluatePasswordVaultTransition(original, bytes(JSON.stringify(v)), vector.context, cas, cas),
    ).toMatchObject({ code: 'INVALID_TRANSITION' });
  });
  it('refuses exhausted cryptographic counters without incrementing unsafe numbers', () => {
    const v = next();
    v.manifest.generation = Number.MAX_SAFE_INTEGER;
    const envelope = JSON.parse(v.passwordEnvelope) as { header: { revision: number } };
    envelope.header.revision = Number.MAX_SAFE_INTEGER;
    v.passwordEnvelope = JSON.stringify(envelope);
    const exhausted = bytes(JSON.stringify(v));
    expect(
      evaluatePasswordVaultTransition(exhausted, exhausted, vector.context, cas, cas),
    ).toMatchObject({ code: 'INVALID_TRANSITION' });
  });
  it('distinguishes missing, replay, rejection and different request without returning secrets', () => {
    const identity = {
      account: 'a',
      operationId: 'id',
      kind: 'initial-publication' as const,
      expectedStorageRevision: null,
      expectedCredentialRevision: '1',
      fingerprint: 'protected',
    };
    expect(classifyVaultOperationReplay(identity, null)).toBe('unknown');
    expect(
      classifyVaultOperationReplay(
        { ...identity, expectedCredentialRevision: '2' },
        { identity, status: 'committed' },
      ),
    ).toBe('mismatch');
    expect(classifyVaultOperationReplay(identity, { identity, status: 'committed' })).toBe(
      'committed',
    );
    expect(
      classifyVaultOperationReplay(identity, {
        identity,
        status: 'rejected',
        code: 'VERSION_CONFLICT',
      }),
    ).toBe('rejected');
    expect(
      classifyVaultOperationReplay(
        { ...identity, fingerprint: 'other' },
        { identity, status: 'committed' },
      ),
    ).toBe('mismatch');
  });
});
