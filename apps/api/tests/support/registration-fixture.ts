import type { DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module.js';
import type { RegistrationEmailTransport } from '../../src/auth/registration/postgres-email-registration.js';
import {
  registrationEmailTransport,
  RegistrationModule,
  registrationPasswordBlocklist,
} from '../../src/auth/registration/registration.module.js';
import type { RegistrationConfig } from '../../src/auth/registration/registration-config.js';
import { readRegistrationConfig } from '../../src/auth/registration/registration-config.js';
import type { PasswordBlocklist } from '../../src/auth/registration/registration-policy.js';
import { configureHttpTransport } from '../../src/shared/http/http-transport.js';

/** Fixtures exist exclusively in tests and cannot be enabled by server environment variables. */
export class CapturingRegistrationEmail implements RegistrationEmailTransport {
  public messages: { to: string; token: string; expiresAt: Date }[] = [];
  public unavailable = false;
  public uncertain = false;
  public async checkAvailability(): Promise<void> {
    if (this.unavailable) throw new Error('SMTP fixture unavailable');
  }
  public async submitVerification(message: {
    to: string;
    token: string;
    expiresAt: Date;
  }): Promise<void> {
    this.messages.push(message);
    if (this.uncertain) throw new Error(`SMTP fixture uncertain ${message.token}`);
  }
}

export function registrationTestConfig(): RegistrationConfig {
  const config = readRegistrationConfig({
    REGISTRATION_ENABLED: 'true',
    REGISTRATION_SMTP_HOST: 'smtp.example.com',
    REGISTRATION_SMTP_USER: 'fixture',
    REGISTRATION_SMTP_PASSWORD: 'fixture-only',
    REGISTRATION_SMTP_FROM: 'security@example.com',
    REGISTRATION_HMAC_KEY: 'b'.repeat(64),
  })!;
  // Fast deterministic adapters only; production's environment enforces a much larger floor.
  return { ...config, requestFloorMs: 30, limits: { ...config.limits, requestsPerSource: 20 } };
}

export async function registrationApplication(
  url: string,
  transport: CapturingRegistrationEmail,
  blocklist: PasswordBlocklist,
  config = registrationTestConfig(),
): Promise<NestExpressApplication> {
  const root = AppModule.register({
    databaseUrl: url,
    host: '127.0.0.1',
    port: 0,
    mode: 'test',
    registration: config,
  });
  const module = root.imports!.find(
    (value) =>
      typeof value === 'object' && 'module' in value && value.module === RegistrationModule,
  ) as DynamicModule;
  module.providers = module.providers!.map((provider) => {
    if (typeof provider !== 'function' && 'provide' in provider) {
      if (provider.provide === registrationEmailTransport)
        return { provide: provider.provide, useValue: transport };
      if (provider.provide === registrationPasswordBlocklist)
        return { provide: provider.provide, useValue: blocklist };
    }
    return provider;
  });
  const app = await NestFactory.create<NestExpressApplication>(root, {
    logger: false,
    abortOnError: false,
    bodyParser: false,
  });
  try {
    configureHttpTransport(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
