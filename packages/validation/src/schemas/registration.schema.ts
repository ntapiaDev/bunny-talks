import { z } from 'zod';
import { loginEmailSchema } from './email.schema.js';

export const registrationRequestSchema = z.strictObject({ email: loginEmailSchema });

// The service validates the proof and password policy; transport only bounds their representation.
export const registrationCompleteSchema = z.strictObject({
  email: loginEmailSchema,
  token: z.string().min(1).max(128),
  password: z.string().max(1024),
});

export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;
export type RegistrationComplete = z.infer<typeof registrationCompleteSchema>;
