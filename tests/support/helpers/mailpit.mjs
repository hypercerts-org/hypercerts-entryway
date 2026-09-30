const defaultTimeoutMs = 20_000
const pollIntervalMs = 250

function timestamp(value) {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(time)) throw new TypeError('Mailpit lookup requires a valid since timestamp')
  return time
}

function includesRecipient(message, recipient) {
  return message.To?.some(({ Address }) => Address?.toLowerCase() === recipient.toLowerCase()) ?? false
}

async function readJson(url, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('Mailpit API request failed')
  return response.json()
}

export async function waitForMailpitCode({
  recipient,
  since,
  excludeIds = [],
  baseUrl = process.env.MAILPIT_URL,
  timeoutMs = defaultTimeoutMs,
} = {}) {
  if (typeof recipient !== 'string' || !recipient.includes('@'))
    throw new TypeError('Mailpit lookup requires a recipient address')
  if (typeof baseUrl !== 'string' || !baseUrl)
    throw new Error('MAILPIT_URL is required')
  if (!Array.isArray(excludeIds) || excludeIds.some((id) => typeof id !== 'string'))
    throw new TypeError('Mailpit excluded message IDs must be strings')
  const receivedAfter = timestamp(since)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new RangeError('Mailpit wait timeout must be between 1 and 60000 milliseconds')

  let origin
  try {
    origin = new URL(baseUrl)
  } catch {
    throw new TypeError('MAILPIT_URL must be a valid URL')
  }
  if (origin.protocol !== 'https:') throw new Error('MAILPIT_URL must use managed HTTPS')
  if (origin.username || origin.password) throw new Error('MAILPIT_URL must not include credentials')
  const endpoint = new URL('/api/v1/search', origin)
  endpoint.searchParams.set('query', `to:${recipient}`)
  endpoint.searchParams.set('limit', '50')
  const excluded = new Set(excludeIds)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const requestSignal = AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now())))
    const result = await readJson(endpoint, requestSignal)
    const message = result.messages?.find((candidate) =>
      typeof candidate.ID === 'string' &&
      !excluded.has(candidate.ID) &&
      includesRecipient(candidate, recipient) &&
      Date.parse(candidate.Created) >= receivedAfter,
    )
    if (message) {
      const detailUrl = new URL(`/api/v1/message/${encodeURIComponent(message.ID)}`, origin)
      const detail = await readJson(detailUrl, requestSignal)
      if (!includesRecipient(detail, recipient)) throw new Error('Mailpit message recipient did not match')
      const code = /Use\s+(\d{8})\s+to/.exec(detail.Text ?? '')?.[1]
      if (code) return { code, messageId: message.ID, receivedAt: new Date(message.Created) }
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)))
  }
  throw new Error('Timed out waiting for a new Mailpit verification message')
}
