export type MailPurpose = "sign-in" | "proof";

export interface MailMessage {
  recipient: string;
  purpose: string;
  code: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailError extends Error {
  readonly code: "MailDeliveryFailed" | "MailInputInvalid";
}

export interface OtpMailRequest {
  email: string;
  otp: string;
  type: string;
}
export interface ProofMailRequest {
  email: string;
  token: string;
  purpose: string;
}
