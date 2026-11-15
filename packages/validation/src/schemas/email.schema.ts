import { z } from 'zod';

export const emailSchema = z.email();

export type Email = z.infer<typeof emailSchema>;

// V1 deliberately supports ASCII dot-atom mailboxes and DNS domains only.
// Fold ASCII case only; provider-specific alias rules are not identity rules.
export const loginEmailSchema = emailSchema.max(254).refine((value) => {
  if (!/^[\x21-\x7e]+$/.test(value)) return false;
  const [local, domain] = value.split('@');
  return (
    local !== undefined &&
    local.length <= 64 &&
    domain !== undefined &&
    domain
      .split('.')
      .every(
        (label) => label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
      )
  );
});

export function canonicalizeLoginEmail(value: unknown): { display: string; canonical: string } {
  const display = loginEmailSchema.parse(value);
  return {
    display,
    canonical: display.toLowerCase(),
  };
}
