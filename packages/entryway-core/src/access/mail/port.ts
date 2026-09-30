import type {
  ClockPort,
  MailOutboxTransactor,
  MailTransport,
} from './types.js'

export interface MailFeatureDependencies {
  outbox: MailOutboxTransactor
  transport: MailTransport
  clock?: ClockPort
}

export interface OtpMailRequest {
  email: string
  otp: string
  type: string
}

export interface ProofMailRequest {
  email: string
  token: string
  purpose: string
}

export interface MailPort {
  sendOtp(request: OtpMailRequest): Promise<void>
  sendProof(request: ProofMailRequest): Promise<void>
  supersedeOtp(request: { email: string; type: string }): number
  retryPending(): Promise<{ delivered: number; failed: number; expired: number }>
  pruneExpired(): number
}
