import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { HttpConfig } from './config.js';
import { Database } from './database.js';
import { SessionController } from './session.controller.js';
import { SessionGuard } from './session.guard.js';
import { SessionHttpService } from './session-http.service.js';

@Module({})
export class SessionModule {
  public static register(config: HttpConfig): DynamicModule {
    return {
      module: SessionModule,
      controllers: [SessionController],
      providers: [
        { provide: Database, useFactory: () => new Database(config) },
        {
          provide: SessionHttpService,
          inject: [Database],
          useFactory: (database: Database) => new SessionHttpService(database),
        },
        { provide: APP_GUARD, useClass: SessionGuard },
      ],
      exports: [Database],
    };
  }
}
