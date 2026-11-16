import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { Request } from 'express';

const checkedRequests = new WeakSet<Request>();

/** Called only after the route's explicit input middleware has accepted the request. */
export function acceptHttpInput(request: Request): void {
  checkedRequests.add(request);
}

/** Missing route input composition is a server error, including on public handlers. */
@Injectable()
export class HttpInputGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    if (!checkedRequests.has(context.switchToHttp().getRequest<Request>()))
      throw new InternalServerErrorException();
    return true;
  }
}
