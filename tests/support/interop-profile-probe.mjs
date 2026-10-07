// Read-only compatibility probe. An invalid empty subject cannot change an account.
import { readFileSync } from 'node:fs'
const config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, 'utf8'))
const call = async (url, options) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}
const moderation = await call(`${config.issuer}/xrpc/com.atproto.admin.updateSubjectStatus`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString('base64')}`,
  },
  body: JSON.stringify({}),
})
const descriptions = []
for (const origin of [config.issuer, ...config.pds.map((p) => p.url)]) {
  const result = await call(`${origin}/xrpc/com.atproto.server.describeServer`)
  descriptions.push({
    origin,
    status: result.status,
    domains: result.body.availableUserDomains,
    inviteCodeRequired: result.body.inviteCodeRequired ?? false,
  })
}
const missingModeration = moderation.status === 404 || moderation.status === 501
console.log(
  JSON.stringify(
    {
      profile: 'entryway-pds-interop 2026-10-01',
      pdsVersion: JSON.parse(readFileSync('node_modules/@atproto/pds/package.json')).version,
      moderation: {
        status: moderation.status,
        error: moderation.body.error,
        result: missingModeration ? 'MISSING_REQUIRED_MODERATION_COORDINATION' : 'REQUIRES_LIFECYCLE_VALIDATION',
        classification: 'user-required-moderation-coordination',
      },
      descriptions,
    },
    null,
    2,
  ),
)
// Entryway moderation coordination is now an explicit user requirement.
// A present route still needs lifecycle validation; this probe only detects absence.
process.exitCode = missingModeration ? 2 : 0
