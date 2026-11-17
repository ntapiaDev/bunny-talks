import { z } from 'zod';
import { loginEmailSchema } from './email.schema.js';

export const loginSchema = z.strictObject({
  email: loginEmailSchema,
  // Match the existing password encoder without imposing registration's minimum length.
  password: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (value) =>
        !/[\uD800-\uDFFF]/u.test(value) &&
        Array.from(value).reduce((bytes, character) => {
          const point = character.codePointAt(0)!;
          return bytes + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4);
        }, 0) <= 1024,
    ),
});

export type LoginInput = z.infer<typeof loginSchema>;
