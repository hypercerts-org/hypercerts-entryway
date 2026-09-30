import type { MailMessage } from './types.js'

const MAX_ADDRESS_LENGTH = 320

export function validateMailAddress(value: string): string {
  const recipient = value.trim().toLowerCase()
  if (
    recipient.length > MAX_ADDRESS_LENGTH ||
    /[\r\n\0]/.test(recipient) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)
  )
    throw Object.assign(new Error('Enter a valid email address'), { code: 'MailInputInvalid' })
  return recipient
}

const purposeLabels: Record<string, string> = {
  'sign-in': 'sign in to Entryway',
  'account-migrate': 'confirm your account migration',
  'backup-add': 'verify your recovery email',
  'email-old': 'confirm your current email',
  'email-new': 'confirm your new email',
  'recovery-backup': 'recover your Entryway account',
  'recovery-new-email': 'confirm your recovered email',
  'account-delete': 'confirm account deletion',
}

export function createOtpMessage(
  recipientValue: string,
  code: string,
  purpose: string,
): MailMessage {
  const recipient = validateMailAddress(recipientValue)
  if (!/^\d{8}$/.test(code))
    throw Object.assign(new Error('The verification code is invalid'), { code: 'MailInputInvalid' })
  const action = purposeLabels[purpose] ?? 'continue with your Entryway account'
  const subject = 'Your Entryway verification code'
  const text = `Use ${code} to ${action}. This code expires in 10 minutes. If you did not request it, ignore this message.`
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${subject}</title><p>Use this code to ${action}.</p><p><strong style="font:700 28px ui-monospace,monospace;letter-spacing:.12em">${code}</strong></p><p>This code expires in 10 minutes. If you did not request it, ignore this message.</p>`
  return { recipient, purpose, code, subject, text, html }
}

export function proofCode(token: string): string {
  const match = /^([A-Za-z0-9_-]{20,})\.(\d{8})$/.exec(token)
  const code = match?.[2]
  if (!code)
    throw Object.assign(new Error('The verification request is invalid'), { code: 'MailInputInvalid' })
  return code
}
