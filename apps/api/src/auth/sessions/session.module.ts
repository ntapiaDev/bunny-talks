import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module, RequestMethod } from '@nestjs/common';
import { Database } from '../../shared/database/database.js';
import { jsonBodyPolicy, noInputPolicy } from '../../shared/http/http-policy.js';
import { PostgresSessionRepository } from './postgres-session-repository.js';
import { SessionController } from './session.controller.js';
import { SessionHttpService } from './session-http.service.js';

@Module({})
export class SessionModule implements NestModule {
  public static register(databaseModule: DynamicModule): DynamicModule {
    return {
      module: SessionModule,
      imports: [databaseModule],
      controllers: [SessionController],
      providers: [
        {
          provide: SessionHttpService,
          inject: [Database],
          useFactory: (database: Database) =>
            new SessionHttpService(new PostgresSessionRepository(database.client)),
        },
      ],
      exports: [SessionHttpService],
    };
  }

  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(jsonBodyPolicy(), noInputPolicy('/v1/session', ['GET', 'DELETE']))
      .forRoutes({ path: 'v1/session', method: RequestMethod.ALL });
  }
}
