import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { SessionState } from './postgres-session-repository.js';
import { SessionHttpService } from './session-http.service.js';
import { parseSessionToken } from './session-token.js';

const publicRouteKey = Symbol('publicRoute');
export const PublicRoute = () => SetMetadata(publicRouteKey, true);
interface SessionContext {
  readonly token: string;
  readonly session: SessionState;
}
// Do not add the authenticated context or another bearer copy to request properties.
const contexts = new WeakMap<Request, SessionContext>();
export function authenticatedSession(request: Request): SessionContext {
  const context = contexts.get(request);
  if (!context) throw new InternalServerErrorException();
  return context;
}

export function parseBearer(rawHeaders: readonly string[]): string {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'authorization')
      values.push(rawHeaders[index + 1] ?? '');
  }
  if (values.length !== 1) throw new UnauthorizedException();
  // Scheme names are case-insensitive; separators and token representation are strict.
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(values[0]!);
  if (!match) throw new UnauthorizedException();
  const token = match[1]!;
  try {
    const parsed = parseSessionToken(token);
    parsed.hash.fill(0);
  } catch {
    throw new UnauthorizedException();
  }
  return token;
}

@Injectable()
export class SessionGuard implements CanActivate {
  public constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionHttpService) private readonly sessions: SessionHttpService,
  ) {}
  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(publicRouteKey, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    )
      return true;
    const request = context.switchToHttp().getRequest<Request>();
    const token = parseBearer(request.rawHeaders);
    const session = await this.sessions.authenticate(token);
    contexts.set(request, { token, session });
    return true;
  }
}
