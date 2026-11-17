import { z } from 'zod';
import { loginSchema } from './login.schema.js';
import {
  initialVaultPublicationSchema,
  publicationDigestSchema,
} from './vault-publication.schema.js';

export const vaultBootstrapReceiptSchema = z.strictObject({
  request: initialVaultPublicationSchema,
  candidateDigest: publicationDigestSchema,
});

export const vaultBootstrapSchema = vaultBootstrapReceiptSchema.extend({
  password: loginSchema.shape.password,
});

export type VaultBootstrapInput = z.infer<typeof vaultBootstrapSchema>;
export type VaultBootstrapReceiptInput = z.infer<typeof vaultBootstrapReceiptSchema>;
