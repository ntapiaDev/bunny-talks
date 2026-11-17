import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module, RequestMethod } from '@nestjs/common';
import { PostgresInitialDeviceBootstrap } from '../auth/bootstrap/postgres-initial-device-bootstrap.js';
import { Database } from '../shared/database/database.js';
import { exactJsonRoutePolicy, jsonBodyPolicy } from '../shared/http/http-policy.js';
import { BootstrapController } from './bootstrap.controller.js';
import type { BootstrapConfig } from './bootstrap-config.js';
import { BootstrapHttpService } from './bootstrap-http.service.js';
import { PostgresBootstrapLimits } from './postgres-bootstrap-limits.js';
import { PostgresVaultRepository } from './postgres-vault-repository.js';

export const bootstrapMaxBodyBytes = 192 * 1024;

@Module({})
export class VaultModule implements NestModule {
  public static register(databaseModule: DynamicModule, config?: BootstrapConfig): DynamicModule {
    return {
      module: VaultModule,
      imports: [databaseModule],
      controllers: [BootstrapController],
      providers: [
        {
          provide: BootstrapHttpService,
          inject: [Database],
          useFactory: (database: Database) =>
            new BootstrapHttpService(
              config
                ? {
                    bootstrap: new PostgresInitialDeviceBootstrap(
                      database.client,
                      new PostgresVaultRepository(database.client, config.keys),
                    ),
                    limits: new PostgresBootstrapLimits(database.client, config),
                  }
                : undefined,
            ),
        },
      ],
      exports: [],
    };
  }

  public configure(consumer: MiddlewareConsumer): void {
    for (const path of ['/v1/vault/bootstrap', '/v1/vault/bootstrap/receipt']) {
      consumer
        .apply(jsonBodyPolicy(bootstrapMaxBodyBytes), exactJsonRoutePolicy(path, ['POST']))
        .forRoutes({ path: path.slice(1), method: RequestMethod.ALL });
    }
  }
}
