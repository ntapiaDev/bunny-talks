import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { vaultBootstrapReceiptSchema, vaultBootstrapSchema } from '@bunny-talks/validation';
import { authenticatedSession } from '../auth/sessions/session.guard.js';
import { BootstrapHttpService } from './bootstrap-http.service.js';

@Controller('v1/vault/bootstrap')
export class BootstrapController {
  public constructor(
    @Inject(BootstrapHttpService) private readonly bootstrap: BootstrapHttpService,
  ) {}

  @Post()
  @HttpCode(200)
  public async activate(@Body() body: unknown, @Req() request: Request) {
    const input = vaultBootstrapSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    return this.bootstrap.execute(
      input.data,
      authenticatedSession(request),
      request.socket.remoteAddress ?? 'unknown',
    );
  }

  @Post('receipt')
  @HttpCode(200)
  public async receipt(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = vaultBootstrapReceiptSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    const result = await this.bootstrap.execute(
      input.data,
      authenticatedSession(request),
      request.socket.remoteAddress ?? 'unknown',
    );
    if (result.status === 'unknown') response.status(202);
    return result;
  }
}
