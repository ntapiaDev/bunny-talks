import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Controller, Get, Module, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PublicRoute, SessionGuard } from './auth/sessions/session.guard.js';
import { SessionModule } from './auth/sessions/session.module.js';
import type { HttpConfig } from './config.js';
import { DatabaseModule } from './shared/database/database.module.js';
import { HttpInputGuard } from './shared/http/http-input.guard.js';
import { jsonBodyPolicy, noInputPolicy } from './shared/http/http-policy.js';

@Controller('health/live')
class HealthController {
  @Get()
  @PublicRoute()
  public live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

@Module({})
export class AppModule implements NestModule {
  public static register(config: HttpConfig): DynamicModule {
    // Share this exact module instance with every consumer; never register it per domain.
    const databaseModule = DatabaseModule.register(config.databaseUrl);
    return {
      module: AppModule,
      imports: [databaseModule, SessionModule.register(databaseModule)],
      controllers: [HealthController],
      providers: [
        { provide: APP_GUARD, useClass: HttpInputGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
      ],
    };
  }

  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(jsonBodyPolicy(), noInputPolicy('/health/live', ['GET']))
      .forRoutes({ path: 'health/live', method: RequestMethod.ALL });
  }
}
