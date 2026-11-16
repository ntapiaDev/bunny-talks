import { Controller, Delete, Get, HttpCode, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';
import { authenticatedSession } from './session.guard.js';
import type { SessionDto } from './session-http.service.js';
import { sessionDto, SessionHttpService } from './session-http.service.js';

@Controller('v1/session')
export class SessionController {
  public constructor(@Inject(SessionHttpService) private readonly sessions: SessionHttpService) {}
  @Get()
  public read(@Req() request: Request): SessionDto {
    return sessionDto(authenticatedSession(request).session);
  }
  @Delete()
  @HttpCode(204)
  public async revoke(@Req() request: Request): Promise<void> {
    await this.sessions.revokeCurrent(authenticatedSession(request).token);
  }
}
