import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module, RequestMethod } from '@nestjs/common';
import { Database } from '../../shared/database/database.js';
import { exactJsonRoutePolicy, jsonBodyPolicy } from '../../shared/http/http-policy.js';
import type { RegistrationEmailTransport } from './postgres-email-registration.js';
import { PostgresEmailRegistration } from './postgres-email-registration.js';
import { PostgresRegistrationLimits } from './postgres-registration-limits.js';
import { PwnedPasswords } from './pwned-passwords.js';
import { RegistrationController } from './registration.controller.js';
import type { RegistrationConfig } from './registration-config.js';
import { RegistrationHttpService } from './registration-http.service.js';
import type { PasswordBlocklist } from './registration-policy.js';
import { SmtpRegistrationEmail } from './smtp-registration-email.js';

export const registrationEmailTransport = Symbol('RegistrationEmailTransport');
export const registrationPasswordBlocklist = Symbol('PasswordBlocklist');

@Module({})
export class RegistrationModule implements NestModule {
  public static register(
    databaseModule: DynamicModule,
    config?: RegistrationConfig,
  ): DynamicModule {
    return {
      module: RegistrationModule,
      imports: [databaseModule],
      controllers: [RegistrationController],
      providers: config
        ? [
            {
              provide: registrationEmailTransport,
              useFactory: () => new SmtpRegistrationEmail(config.smtp),
            },
            { provide: registrationPasswordBlocklist, useFactory: () => new PwnedPasswords() },
            {
              provide: RegistrationHttpService,
              inject: [Database, registrationEmailTransport, registrationPasswordBlocklist],
              useFactory: (
                database: Database,
                transport: RegistrationEmailTransport,
                blocklist: PasswordBlocklist,
              ) => {
                const limits = new PostgresRegistrationLimits(database.client, config);
                return new RegistrationHttpService({
                  config,
                  transport,
                  limits,
                  registration: new PostgresEmailRegistration(
                    database.client,
                    transport,
                    blocklist,
                    undefined,
                    limits,
                  ),
                });
              },
            },
          ]
        : [{ provide: RegistrationHttpService, useFactory: () => new RegistrationHttpService() }],
      // No database client, repository, or registration receipt capability is exported.
      exports: [],
    };
  }

  public configure(consumer: MiddlewareConsumer): void {
    for (const action of ['request', 'complete']) {
      const path = `v1/auth/registration/${action}`;
      consumer
        .apply(jsonBodyPolicy(), exactJsonRoutePolicy(`/${path}`, ['POST']))
        .forRoutes({ path, method: RequestMethod.ALL });
    }
  }
}
