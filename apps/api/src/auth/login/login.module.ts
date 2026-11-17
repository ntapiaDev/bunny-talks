import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module, RequestMethod } from '@nestjs/common';
import { Database } from '../../shared/database/database.js';
import { exactJsonRoutePolicy, jsonBodyPolicy } from '../../shared/http/http-policy.js';
import { PostgresSessionRepository } from '../sessions/postgres-session-repository.js';
import { LoginController } from './login.controller.js';
import { LoginService } from './login.service.js';
import type { LoginConfig } from './login-config.js';
import { PostgresLoginCredentials } from './postgres-login-credentials.js';
import { PostgresLoginLimits } from './postgres-login-limits.js';

@Module({})
export class LoginModule implements NestModule {
  public static register(databaseModule: DynamicModule, config?: LoginConfig): DynamicModule {
    return {
      module: LoginModule,
      imports: [databaseModule],
      controllers: [LoginController],
      providers: [
        {
          provide: LoginService,
          inject: [Database],
          useFactory: (database: Database) =>
            new LoginService(
              config
                ? {
                    config,
                    credentials: new PostgresLoginCredentials(database.client),
                    limits: new PostgresLoginLimits(database.client, config),
                    sessions: new PostgresSessionRepository(database.client),
                  }
                : undefined,
            ),
        },
      ],
      exports: [],
    };
  }

  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(jsonBodyPolicy(), exactJsonRoutePolicy('/v1/auth/login', ['POST']))
      .forRoutes({ path: 'v1/auth/login', method: RequestMethod.ALL });
  }
}
