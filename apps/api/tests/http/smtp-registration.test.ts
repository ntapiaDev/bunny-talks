import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo, Socket } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadLocalEnv } from '../../local-env.mjs';
import { SmtpRegistrationEmail } from '../../src/auth/registration/smtp-registration-email.js';
import { generateOpaqueToken } from '../../src/auth/sessions/session-token.js';
import { createTestDatabase } from '../support/postgres-test-database.js';

loadLocalEnv();

describe('real SMTP adapter protocol over verified TLS', () => {
  let directory: string;
  let key: string;
  let cert: string;
  let originalCertificates: string[];
  beforeAll(async () => {
    originalCertificates = getCACertificates('default');
    directory = await mkdtemp(join(tmpdir(), 'bunny-smtp-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
      ],
      { stdio: 'pipe' },
    );
    key = await readFile(join(directory, 'key.pem'), 'utf8');
    cert = await readFile(join(directory, 'cert.pem'), 'utf8');
    setDefaultCACertificates([...originalCertificates, cert]);
  });
  afterAll(async () => {
    setDefaultCACertificates(originalCertificates);
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function fixture(
    secure: boolean,
    options: { rejectData?: boolean; hangData?: boolean; disableStartTls?: boolean } = {},
  ) {
    const received: { from: string; to: string[]; data: string }[] = [];
    let authentications = 0;
    const server = new SMTPServer({
      secure,
      key,
      cert,
      logger: false,
      hidePIPELINING: true,
      disabledCommands: options.disableStartTls ? ['STARTTLS'] : [],
      onAuth(auth, _session, callback) {
        authentications++;
        callback(
          auth.username === 'fixture' && auth.password === 'fixture-only'
            ? null
            : new Error('Invalid auth'),
          { user: 'fixture' },
        );
      },
      onData(stream, session, callback) {
        let data = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          data += chunk;
        });
        stream.on('end', () => {
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((value) => value.address),
            data,
          });
          if (!options.hangData)
            callback(options.rejectData ? new Error('DATA rejected fixture') : undefined);
        });
      },
    });
    server.on('error', () => undefined);
    server.listen(0, '127.0.0.1');
    await once(server.server, 'listening');
    const port = (server.server.address() as AddressInfo).port;
    const adapter = new SmtpRegistrationEmail({
      host: '127.0.0.1',
      port,
      secure,
      user: 'fixture',
      password: 'fixture-only',
      from: 'security@example.com',
      timeoutMs: 2000,
    });
    return {
      adapter,
      received,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      port,
      authentications: () => authentications,
    };
  }
  it.each([true, false])(
    'authenticates and submits the exact recipient with implicit TLS=%s',
    async (secure) => {
      const f = await fixture(secure);
      try {
        await f.adapter.checkAvailability();
        const token = generateOpaqueToken('e1').token;
        await f.adapter.submitVerification({
          to: 'Alice+tag@Example.com',
          token,
          expiresAt: new Date(Date.now() + 1800000),
        });
        expect(f.received).toHaveLength(1);
        expect(f.received[0]).toMatchObject({
          from: 'security@example.com',
          // The SMTP server normalizes DNS domain case; mailbox case and suffix stay exact.
          to: ['Alice+tag@example.com'],
        });
        const data = f.received[0]!.data.replace(/=\r\n/g, '');
        expect(data).toContain(token);
        expect(data).not.toContain('https://');
        expect(data).not.toContain('fixture-only');
      } finally {
        await f.close();
      }
    },
  );
  it('rejects an untrusted TLS certificate instead of weakening verification', async () => {
    const f = await fixture(true);
    try {
      setDefaultCACertificates(originalCertificates);
      await expect(f.adapter.checkAvailability()).rejects.toThrow('DELIVERY_UNAVAILABLE');
    } finally {
      setDefaultCACertificates([...originalCertificates, cert]);
      await f.close();
    }
  });
  it('sanitizes real SMTP authentication failures', async () => {
    const f = await fixture(true);
    try {
      const adapter = new SmtpRegistrationEmail({
        host: '127.0.0.1',
        port: f.port,
        secure: true,
        user: 'fixture',
        password: 'incorrect-secret',
        from: 'security@example.com',
        timeoutMs: 2000,
      });
      await expect(adapter.checkAvailability()).rejects.toThrow('DELIVERY_UNAVAILABLE');
      expect(f.received).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it('reports rejected DATA as unavailable without exposing the proof', async () => {
    const f = await fixture(true, { rejectData: true });
    try {
      await f.adapter.checkAvailability();
      await expect(
        f.adapter.submitVerification({
          to: 'a@example.com',
          token: generateOpaqueToken('e1').token,
          expiresAt: new Date(),
        }),
      ).rejects.toThrow('DELIVERY_UNAVAILABLE');
    } finally {
      await f.close();
    }
  });
  it('refuses a STARTTLS downgrade before transmitting authentication credentials', async () => {
    const f = await fixture(false, { disableStartTls: true });
    try {
      await expect(f.adapter.checkAvailability()).rejects.toThrow('DELIVERY_UNAVAILABLE');
      expect(f.authentications()).toBe(0);
      expect(f.received).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it('aborts a stalled DATA acknowledgement after sending without claiming acceptance', async () => {
    const f = await fixture(true, { hangData: true });
    try {
      await f.adapter.checkAvailability();
      const start = performance.now();
      await expect(
        f.adapter.submitVerification({
          to: 'a@example.com',
          token: generateOpaqueToken('e1').token,
          expiresAt: new Date(),
        }),
      ).rejects.toThrow('DELIVERY_UNAVAILABLE');
      expect(f.received).toHaveLength(1);
      expect(performance.now() - start).toBeLessThan(3500);
    } finally {
      await f.close();
    }
  });
  it('runs compiled Node ESM registration with real PostgreSQL and SMTP, then shuts down cleanly', async () => {
    const db = await createTestDatabase();
    const f = await fixture(true);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { createHttpApplication } from './dist/src/application.js';
      import { readHttpConfig } from './dist/src/config.js';
      const app = await createHttpApplication(readHttpConfig(process.env));
      await app.listen(0, '127.0.0.1');
      process.send({ url: await app.getUrl() });
      process.on('message', async message => {
        if (message === 'stop') { await app.close(); process.disconnect(); }
      });
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: db.url,
          NODE_ENV: 'test',
          API_HOST: '127.0.0.1',
          API_PORT: '0',
          REGISTRATION_ENABLED: 'true',
          REGISTRATION_SMTP_HOST: '127.0.0.1',
          REGISTRATION_SMTP_PORT: String(f.port),
          REGISTRATION_SMTP_SECURE: 'true',
          REGISTRATION_SMTP_USER: 'fixture',
          REGISTRATION_SMTP_PASSWORD: 'fixture-only',
          REGISTRATION_SMTP_FROM: 'security@example.com',
          REGISTRATION_HMAC_KEY: 'c'.repeat(64),
          REGISTRATION_SMTP_TIMEOUT_MS: '2000',
          NODE_EXTRA_CA_CERTS: join(directory, 'cert.pem'),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let output = '';
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
      output += String(chunk);
    });
    try {
      const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
      const base = (message as { url: string }).url;
      const response = await fetch(`${base}/v1/auth/registration/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'Compiled+SMTP@example.com' }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: 'accepted' });
      expect(f.received).toHaveLength(1);
      const invalid = await fetch(`${base}/v1/auth/registration/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'Compiled+SMTP@example.com',
          token: 'invalid',
          password: 'compiled invalid proof password',
        }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: { code: 'INVALID_VERIFICATION' } });
      expect(output).toBe('');
      const exit = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
      child.send('stop');
      const [code] = await exit;
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) {
        const exit = once(child, 'exit');
        child.kill('SIGTERM');
        await exit;
      }
      await f.close();
      await db.dispose();
    }
  }, 30000);
  it('closes stalled SMTP probes and submissions at the overall deadline', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const adapter = new SmtpRegistrationEmail({
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        secure: true,
        user: 'fixture',
        password: 'fixture-only',
        from: 'security@example.com',
        timeoutMs: 100,
      });
      const start = performance.now();
      await expect(adapter.checkAvailability()).rejects.toThrow('DELIVERY_UNAVAILABLE');
      await expect(
        adapter.submitVerification({
          to: 'a@example.com',
          token: generateOpaqueToken('e1').token,
          expiresAt: new Date(),
        }),
      ).rejects.toThrow('DELIVERY_UNAVAILABLE');
      expect(performance.now() - start).toBeLessThan(1500);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
