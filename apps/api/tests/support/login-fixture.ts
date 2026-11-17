import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createHttpApplication } from '../../src/application.js';
import type { LoginConfig } from '../../src/auth/login/login-config.js';
import { readLoginConfig } from '../../src/auth/login/login-config.js';
import { PostgresEmailRegistration } from '../../src/auth/registration/postgres-email-registration.js';
import { CapturingRegistrationEmail } from './registration-fixture.js';

export const loginPassword = '  exact login e\u0301 😀 Password  ';
export function loginTestConfig(): LoginConfig {
  return readLoginConfig({ LOGIN_ENABLED: 'true', LOGIN_HMAC_KEY: 'c'.repeat(64) })!;
}

/** Accounts always originate from the existing verified-registration primitives. */
export async function registeredLoginAccount(client: PrismaClient) {
  const email = `${randomUUID()}@Example.com`;
  const transport = new CapturingRegistrationEmail();
  const registration = new PostgresEmailRegistration(client, transport, {
    async isBlocked() {
      return false;
    },
  });
  await registration.requestVerification(email);
  await registration.finalize({
    email,
    token: transport.messages[0]!.token,
    password: loginPassword,
  });
  const identity = await client.emailIdentity.findUniqueOrThrow({
    where: { canonical: email.toLowerCase() },
  });
  return { email, accountId: identity.accountId, password: loginPassword };
}

export async function loginApplication(url: string, config = loginTestConfig()) {
  const app = await createHttpApplication({
    databaseUrl: url,
    host: '127.0.0.1',
    port: 0,
    mode: 'test',
    login: config,
  });
  try {
    await app.listen(0, '127.0.0.1');
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
