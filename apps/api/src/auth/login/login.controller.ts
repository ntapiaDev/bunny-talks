import { BadRequestException, Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { loginSchema } from '@bunny-talks/validation';
import { PublicRoute } from '../sessions/session.guard.js';
import { LoginService } from './login.service.js';

@Controller('v1/auth/login')
export class LoginController {
  public constructor(@Inject(LoginService) private readonly authentication: LoginService) {}

  @Post()
  @PublicRoute()
  @HttpCode(201)
  public async login(@Body() body: unknown, @Req() request: Request) {
    const input = loginSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    return this.authentication.login(input.data, request.socket.remoteAddress ?? 'unknown');
  }
}
