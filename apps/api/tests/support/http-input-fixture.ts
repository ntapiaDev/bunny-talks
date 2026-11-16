import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Module,
  Post,
  RequestMethod,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { loginEmailSchema } from '@bunny-talks/validation';
import { AppModule } from '../../src/app.module.js';
import { PublicRoute } from '../../src/auth/sessions/session.guard.js';
import type { HttpConfig } from '../../src/config.js';
import { acceptHttpInput } from '../../src/shared/http/http-input.guard.js';
import { jsonBodyPolicy } from '../../src/shared/http/http-policy.js';

const emailsSchema = loginEmailSchema.array().max(80);
export const fixtureBodyLimit = 16384;

@Controller('__input-fixture')
class InputFixtureController {
  @Post('json')
  @PublicRoute()
  public json(
    @Body({ schema: emailsSchema, pipes: [new StandardSchemaValidationPipe()] }) emails: string[],
  ): { count: number } {
    return { count: emails.length };
  }

  @Post('private')
  public privateJson(): void {}

  @Get('unconfigured')
  public unconfigured(): never {
    throw new Error('Unconfigured handler must not execute');
  }

  @Get('unconfigured-public')
  @PublicRoute()
  public unconfiguredPublic(): never {
    throw new Error('Unconfigured public handler must not execute');
  }

  @Post('parser-only')
  @PublicRoute()
  public parserOnly(): never {
    throw new Error('A parser is not an input validation policy');
  }
}

function fixtureInputPolicy(request: Request, response: Response, next: NextFunction): void {
  if (request.originalUrl.includes('?')) {
    next(new BadRequestException());
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    next(new HttpException('', 405));
    return;
  }
  // This fixture's public body is validated by Nest's standard pipe and the shared Zod schema.
  acceptHttpInput(request);
  next();
}

@Module({})
export class HttpInputFixtureModule implements NestModule {
  public static register(config: HttpConfig): DynamicModule {
    return {
      module: HttpInputFixtureModule,
      imports: [AppModule.register(config)],
      controllers: [InputFixtureController],
    };
  }

  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(jsonBodyPolicy(fixtureBodyLimit), fixtureInputPolicy)
      .forRoutes(
        { path: '__input-fixture/json', method: RequestMethod.ALL },
        { path: '__input-fixture/private', method: RequestMethod.ALL },
      );
    consumer.apply(jsonBodyPolicy()).forRoutes('__input-fixture/parser-only');
  }
}
