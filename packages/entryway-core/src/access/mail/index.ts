export { createOtpMessage, proofCode, validateMailAddress } from './domain.js'
export type { MailFeatureDependencies, MailPort, OtpMailRequest, ProofMailRequest } from './port.js'
export type {
  ClockPort,
  MailMessage,
  MailOutboxEntry,
  MailOutboxReader,
  MailOutboxTransactor,
  MailTransport,
  OutboxState,
} from './types.js'
