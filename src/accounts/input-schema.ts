import { z } from "zod";

export const accountEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254))
  .refine((email) => email.indexOf("@") <= 64, {
    message: "The part before @ must contain at most 64 characters",
  });

export function validateHostedHandle(
  handle: string,
  domains: readonly string[],
): void {
  const domain = domains.find((candidate) => handle.endsWith(candidate));
  const label = domain ? handle.slice(0, -domain.length) : "";
  if (!domain || label.includes(".") || label.length < 3 || label.length > 18)
    throw new Error("InvalidHandle");
}

export const registrationInputSchema = z.strictObject({
  email: accountEmailSchema,
  handle: z.string(),
  pdsId: z.string(),
  recoveryKey: z.string().nullable().optional(),
  inviteCode: z.string().optional(),
});

export type RegistrationInput = z.infer<typeof registrationInputSchema>;
