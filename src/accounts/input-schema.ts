import { z } from "zod";

const boundedEmail = (value: string): boolean => {
  if (value.length > 254 || /\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
};

export const accountEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(boundedEmail);

export function validateHostedHandle(
  handle: string,
  domains: readonly string[],
): void {
  const domain = domains.find((candidate) => handle.endsWith(candidate));
  const label = domain ? handle.slice(0, -domain.length) : "";
  if (!domain || label.includes(".") || label.length < 3 || label.length > 18)
    throw new Error("InvalidHandle");
}

export const registrationInputSchema = z.object({
  // Preserve registration's existing String coercion; email callers share the rule.
  email: z.preprocess((value) => String(value), accountEmailSchema),
  handle: z.string(),
  pdsId: z.string(),
  recoveryKey: z.string().nullable().optional(),
  inviteCode: z.string().optional(),
});

export type RegistrationInput = z.infer<typeof registrationInputSchema>;
