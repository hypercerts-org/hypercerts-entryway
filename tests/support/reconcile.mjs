import { readFileSync } from 'node:fs'
import { request } from 'node:http'
const config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH ?? '/config/config.json', 'utf8'))
// Use the running authority's locks and stores. A second database writer would
// bypass the in-process account/migration serialization used by this spike.
// node:http preserves the canonical Host while connecting only to loopback.
// Node's fetch can replace Host with the connection URL's host.
const results = await new Promise((resolve, reject) => {
  const req = request(
    'http://127.0.0.1:3000/admin/reconcile',
    {
      method: 'POST',
      headers: {
        host: new URL(config.issuer).host,
        authorization: `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(120_000),
    },
    (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          if (response.statusCode !== 200)
            throw new Error(`Reconciliation request failed (${response.statusCode})`)
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    },
  )
  req.on('error', reject)
  req.end()
})
console.log(JSON.stringify(results, null, 2))
if (results.some((r) => r.status !== 'complete')) process.exitCode = 1
