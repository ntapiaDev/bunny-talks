import { z } from 'zod';
import type { LoginResponse, SessionDto, SessionIdentityDto } from '@bunny-talks/contracts';
import { databaseRevisionSchema } from './vault-publication.schema.js';

const accountId = z.string().regex(/^[!-~]{1,128}$/);
const sessionId = z
  .uuid()
  .refine(
    (value) =>
      value === value.toLowerCase() &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value),
  );
const deviceId = sessionId;
const expiresAt = z.iso.datetime({ offset: false });
const sessionIdentityDtoSchema = z.strictObject({
  accountId,
  sessionId,
  deviceId,
  deviceState: z.enum(['pending', 'authorized']),
  expiresAt,
});

export const sessionDtoSchema = sessionIdentityDtoSchema.extend({
  credentialRevision: databaseRevisionSchema,
}) satisfies z.ZodType<SessionDto>;

export const sessionTokenSchema = z
  .string()
  .regex(
    /^s1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/,
  )
  .refine((value) => 'AEIMQUYcgkosw048'.includes(value.at(-1)!));
export const loginResponseSchema = z
  .strictObject({ sessionToken: sessionTokenSchema, session: sessionIdentityDtoSchema })
  .superRefine((response, context) => {
    if (response.sessionToken.split('.')[1] !== response.session.sessionId) {
      context.addIssue({
        code: 'custom',
        path: ['session', 'sessionId'],
        message: 'Session token mismatch',
      });
    }
  }) satisfies z.ZodType<LoginResponse>;

export const sessionIdentityResponseSchema =
  sessionIdentityDtoSchema satisfies z.ZodType<SessionIdentityDto>;
