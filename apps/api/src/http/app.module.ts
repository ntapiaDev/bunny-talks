import type { DynamicModule } from '@nestjs/common';
import { Controller, Get, Module } from '@nestjs/common';
import type { HttpConfig } from './config.js';
import { PublicRoute } from './session.guard.js';
import { SessionModule } from './session.module.js';

@Controller('health/live')
class HealthController {
  @Get()
  @PublicRoute()
  public live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

@Module({})
export class AppModule {
  public static register(config: HttpConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [SessionModule.register(config)],
      controllers: [HealthController],
    };
  }
}
