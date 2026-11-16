import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { PasswordVerifierError } from '../../auth/password-verifier.js';
import { RegistrationError } from '../../auth/registration/registration-policy.js';
import { SessionError } from '../../auth/sessions/session-token.js';

const errorCodes: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

export function classifyHttpError(error: unknown): { status: number; code: string } {
  if (error instanceof RegistrationError) {
    switch (error.code) {
      case 'INVALID_EMAIL':
      case 'INVALID_REQUEST':
        return { status: 400, code: 'BAD_REQUEST' };
      case 'INVALID_PROOF':
      case 'EMAIL_UNAVAILABLE':
        return { status: 400, code: 'INVALID_VERIFICATION' };
      case 'INVALID_PASSWORD':
      case 'BLOCKED_PASSWORD':
        return { status: 422, code: 'PASSWORD_REJECTED' };
      case 'RATE_LIMITED':
        return { status: 429, code: 'TOO_MANY_REQUESTS' };
      case 'DELIVERY_UNAVAILABLE':
        return { status: 503, code: 'DELIVERY_UNAVAILABLE' };
      case 'POLICY_UNAVAILABLE':
        return { status: 503, code: 'PASSWORD_CHECK_UNAVAILABLE' };
      case 'OUTCOME_UNKNOWN':
        return { status: 503, code: 'OUTCOME_UNKNOWN' };
      case 'UNAVAILABLE':
        return { status: 503, code: 'SERVICE_UNAVAILABLE' };
    }
  }
  if (error instanceof PasswordVerifierError) {
    if (error.code === 'INVALID_PASSWORD') return { status: 422, code: 'PASSWORD_REJECTED' };
    if (error.code === 'BUSY') return { status: 429, code: 'TOO_MANY_REQUESTS' };
    return { status: 503, code: 'SERVICE_UNAVAILABLE' };
  }
  let status = 500;
  if (error instanceof SessionError) {
    status = error.code === 'INVALID_SESSION' ? 401 : error.code === 'INVALID_INPUT' ? 400 : 503;
  } else if (error instanceof HttpException) status = error.getStatus();
  // Only recognize the parser's fixed error types, never driver messages or arbitrary statuses.
  else if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.too.large') status = 413;
    else if (
      error.type === 'entity.parse.failed' ||
      error.type === 'request.aborted' ||
      error.type === 'request.size.invalid'
    )
      status = 400;
    else if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported')
      status = 415;
  }
  if (!errorCodes[status]) status = 500;
  return { status, code: errorCodes[status]! };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  public catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const { status, code } = classifyHttpError(error);
    response.setHeader('Cache-Control', 'no-store');
    if (status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
    response.status(status).json({ error: { code } });
  }
}
