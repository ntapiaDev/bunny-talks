import 'reflect-metadata';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { vaultBootstrapReceiptSchema, vaultBootstrapSchema } from '@bunny-talks/validation';
import { AppModule } from '../../../src/app.module.js';
import { InitialBootstrapError } from '../../../src/auth/bootstrap/initial-bootstrap-error.js';
import type { SessionState } from '../../../src/auth/sessions/postgres-session-repository.js';
import { SessionGuard } from '../../../src/auth/sessions/session.guard.js';
import type { SessionHttpService } from '../../../src/auth/sessions/session-http.service.js';
import { classifyHttpError } from '../../../src/shared/http/http-error-filter.js';
import { BootstrapController } from '../../../src/vault/bootstrap.controller.js';
import { readBootstrapConfig } from '../../../src/vault/bootstrap-config.js';
import { BootstrapHttpService } from '../../../src/vault/bootstrap-http.service.js';
import { bootstrapMaxBodyBytes } from '../../../src/vault/vault.module.js';
import { VaultRepositoryError } from '../../../src/vault/vault-repository-error.js';

const environment = {
  VAULT_BOOTSTRAP_ENABLED: 'true',
  VAULT_BOOTSTRAP_QUOTA_KEY: 'd'.repeat(64),
  VAULT_RECEIPT_ACTIVE_KEY_ID: 'current',
  VAULT_RECEIPT_KEYS: JSON.stringify([
    { id: 'current', key: 'e'.repeat(64) },
    { id: 'old', key: 'f'.repeat(64) },
  ]),
};
const input = () => ({
  password: 'exact password',
  request: {
    transportVersion: 1 as const,
    operationId: randomUUID(),
    account: 'account',
    vaultId: randomBytes(16).toString('base64url'),
    expectedCredentialRevision: '1',
    expectedStorageRevision: null,
    publicationBase64Url: 'e30',
  },
  candidateDigest: randomBytes(32).toString('base64url'),
});
describe('bootstrap HTTP schemas, composition and fixed errors', () => {
  it('validates activation and password-free receipt envelopes', () => {
    const body = input();
    expect(vaultBootstrapSchema.safeParse(body).success).toBe(true);
    const receipt = { request: body.request, candidateDigest: body.candidateDigest };
    expect(vaultBootstrapReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(vaultBootstrapReceiptSchema.safeParse(body).success).toBe(false);
    expect(vaultBootstrapSchema.safeParse(receipt).success).toBe(false);
  });
  it.each(['deviceId', 'sessionId', 'authorizedAt', 'sessionToken', 'backupConfirmed'])(
    'refuses client %s at either level',
    (name) => {
      const body = input();
      for (const schema of [vaultBootstrapSchema, vaultBootstrapReceiptSchema]) {
        const candidate =
          schema === vaultBootstrapSchema
            ? body
            : { request: body.request, candidateDigest: body.candidateDigest };
        expect(schema.safeParse({ ...candidate, [name]: 'untrusted' }).success).toBe(false);
        expect(
          schema.safeParse({ ...candidate, request: { ...body.request, [name]: 'untrusted' } })
            .success,
        ).toBe(false);
      }
    },
  );
  it.each([undefined, null, 123, '', '\ud800', '😀'.repeat(257)])(
    'refuses malformed password %#',
    (password) => {
      expect(vaultBootstrapSchema.safeParse({ ...input(), password }).success).toBe(false);
    },
  );
  it.each([
    ['transportVersion', 2],
    ['operationId', randomUUID().toUpperCase()],
    ['expectedCredentialRevision', '01'],
    ['expectedCredentialRevision', 1],
    ['expectedStorageRevision', '1'],
    ['publicationBase64Url', 'abc='],
    ['publicationBase64Url', 'ab'],
    ['publicationBase64Url', 'a'],
  ])('refuses noncanonical %s (%s)', (field, value) => {
    const body = input();
    expect(
      vaultBootstrapSchema.safeParse({
        ...body,
        request: { ...body.request, [field as string]: value },
      }).success,
    ).toBe(false);
  });
  it.each(['x', 'a'.repeat(43), null, 1, 'A'.repeat(42) + '='])(
    'refuses digest %#',
    (candidateDigest) => {
      expect(vaultBootstrapSchema.safeParse({ ...input(), candidateDigest }).success).toBe(false);
    },
  );
  it('accepts exactly 131072 decoded bytes and bounds the full worst-case JSON envelope', () => {
    const body = input();
    body.password = '\0'.repeat(1024);
    body.request.account = '"'.repeat(128);
    body.request.expectedCredentialRevision = '9223372036854775807';
    body.request.publicationBase64Url = Buffer.alloc(131072).toString('base64url');
    expect(body.request.publicationBase64Url.length).toBe(174763);
    expect(vaultBootstrapSchema.safeParse(body).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(bootstrapMaxBodyBytes);
    body.request.publicationBase64Url = Buffer.alloc(131073).toString('base64url');
    expect(vaultBootstrapSchema.safeParse(body).success).toBe(false);
  });
  it('defaults to disabled and keeps independent activation blocked in production', () => {
    expect(readBootstrapConfig({})).toBeUndefined();
    expect(
      readBootstrapConfig({ ...environment, VAULT_BOOTSTRAP_ENABLED: 'false' }),
    ).toBeUndefined();
    expect(() => readBootstrapConfig({ ...environment, NODE_ENV: 'production' })).toThrow(
      'Invalid vault bootstrap configuration',
    );
    expect(() =>
      AppModule.register({
        databaseUrl: '',
        host: '127.0.0.1',
        port: 1,
        mode: 'production',
        bootstrap: readBootstrapConfig(environment)!,
      }),
    ).toThrow('Invalid vault bootstrap configuration');
  });
  it('keeps historical keys and returns no key for an unknown identifier', () => {
    const config = readBootstrapConfig(environment)!;
    expect(config.keys.getKey('current')?.symmetricKeySize).toBe(32);
    expect(config.keys.getKey('old')?.symmetricKeySize).toBe(32);
    expect(config.keys.getKey('unknown')).toBeUndefined();
  });
  it.each([
    { VAULT_RECEIPT_KEYS: '' },
    { VAULT_RECEIPT_KEYS: '{}' },
    { VAULT_RECEIPT_KEYS: '[]' },
    { VAULT_RECEIPT_ACTIVE_KEY_ID: 'missing' },
    { VAULT_BOOTSTRAP_QUOTA_KEY: '' },
    { VAULT_BOOTSTRAP_CONCURRENCY: '3' },
    { LOGIN_HMAC_KEY: 'd'.repeat(64) },
    { REGISTRATION_HMAC_KEY: 'e'.repeat(64) },
    { VAULT_RECEIPT_KEYS: JSON.stringify([{ id: 'current', key: 'short-secret' }]) },
    { VAULT_RECEIPT_KEYS: JSON.stringify([{ id: 'current', key: 'd'.repeat(64) }]) },
  ])('rejects invalid or reused configuration keys without exposing them %#', (change) => {
    expect(() => readBootstrapConfig({ ...environment, ...change })).toThrow(
      /^Invalid vault bootstrap configuration$/,
    );
  });
  it.each(['activate', 'receipt'] as const)(
    'protects %s without PublicRoute metadata',
    async (method) => {
      const authenticate = vi.fn();
      const guard = new SessionGuard(new Reflector(), {
        authenticate,
      } as unknown as SessionHttpService);
      const context = {
        getHandler: () => BootstrapController.prototype[method],
        getClass: () => BootstrapController,
        switchToHttp: () => ({ getRequest: () => ({ rawHeaders: [] }) }),
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(authenticate).not.toHaveBeenCalled();
    },
  );
  it.each([
    [new InitialBootstrapError('INVALID_AUTHENTICATION'), 401, 'UNAUTHORIZED'],
    [new InitialBootstrapError('NOT_ELIGIBLE'), 403, 'FORBIDDEN'],
    [new InitialBootstrapError('HISTORICAL_STATE'), 403, 'FORBIDDEN'],
    [new InitialBootstrapError('REPLAY_FORBIDDEN'), 403, 'FORBIDDEN'],
    [new InitialBootstrapError('OUTCOME_UNKNOWN'), 503, 'OUTCOME_UNKNOWN'],
    [new VaultRepositoryError('INVALID_PUBLICATION'), 400, 'BAD_REQUEST'],
    [new VaultRepositoryError('INVALID_INPUT'), 400, 'BAD_REQUEST'],
    [new VaultRepositoryError('KEY_UNAVAILABLE'), 503, 'SERVICE_UNAVAILABLE'],
    [new VaultRepositoryError('CORRUPT_STORAGE'), 503, 'SERVICE_UNAVAILABLE'],
    [new VaultRepositoryError('TRANSACTION_OUTCOME_UNKNOWN'), 503, 'OUTCOME_UNKNOWN'],
  ])('classifies %s', (error, status, code) => {
    expect(classifyHttpError(error)).toEqual({ status, code });
  });
  it('recovers exclusively, releases admission and never falls back on activation', async () => {
    const activate = vi.fn();
    const recoverReceipt = vi.fn().mockResolvedValue({ transportVersion: 1, status: 'unknown' });
    const release = vi.fn();
    const limits = {
      admit: vi.fn(),
      cleanup: vi.fn(),
      acquire: vi.fn().mockResolvedValue({ release }),
    };
    const service = new BootstrapHttpService({ bootstrap: { activate, recoverReceipt }, limits });
    const context = {
      token: 'opaque',
      session: { accountId: 'account', deviceId: 'device' } as SessionState,
    };
    const body = input();
    const receipt = { request: body.request, candidateDigest: body.candidateDigest };
    expect(await service.execute(receipt, context, 'source')).toEqual({
      transportVersion: 1,
      status: 'unknown',
    });
    expect(activate).not.toHaveBeenCalled();
    expect(recoverReceipt).toHaveBeenCalledWith(
      context.token,
      receipt.request,
      receipt.candidateDigest,
    );
    expect(limits.admit).toHaveBeenCalledWith('source', 'account', 'device', false);
    expect(release).toHaveBeenCalledOnce();
    await expect(
      service.execute(
        receipt,
        { ...context, session: { ...context.session, accountId: 'other' } },
        'source',
      ),
    ).rejects.toThrow('INVALID_AUTHENTICATION');
    expect(limits.admit).toHaveBeenCalledOnce();
    await expect(new BootstrapHttpService().execute(receipt, context, 'source')).rejects.toThrow(
      'UNAVAILABLE',
    );
  });
});
