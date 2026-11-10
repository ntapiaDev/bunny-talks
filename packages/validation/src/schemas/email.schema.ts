import { z } from 'zod';

export const emailSchema = z.email();

export type Email = z.infer<typeof emailSchema>;
