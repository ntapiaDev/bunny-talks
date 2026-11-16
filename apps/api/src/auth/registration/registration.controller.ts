import { BadRequestException, Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { registrationCompleteSchema, registrationRequestSchema } from '@bunny-talks/validation';
import { PublicRoute } from '../sessions/session.guard.js';
import { RegistrationHttpService } from './registration-http.service.js';

@Controller('v1/auth/registration')
export class RegistrationController {
  public constructor(
    @Inject(RegistrationHttpService) private readonly registration: RegistrationHttpService,
  ) {}

  @Post('request')
  @PublicRoute()
  @HttpCode(202)
  public async request(@Body() body: unknown, @Req() request: Request) {
    const input = registrationRequestSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    return this.registration.request(input.data, request.socket.remoteAddress ?? 'unknown');
  }

  @Post('complete')
  @PublicRoute()
  @HttpCode(200)
  public async complete(@Body() body: unknown, @Req() request: Request) {
    const input = registrationCompleteSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    return this.registration.complete(input.data, request.socket.remoteAddress ?? 'unknown');
  }
}
