import { createReadStream, promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { join, normalize } from 'node:path'

const root = process.env.APP_ROOT || '/app/dist'
const appUrl = required('APP_URL')
const pdsUrl = required('PDS_URL')
const plcUrl = required('PLC_URL')
const metadata = {
  client_id: `${appUrl}/oauth-client-metadata.json`,
  client_name: 'Entryway browser client',
  application_type: 'web',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  redirect_uris: [`${appUrl}/callback`],
  scope: 'atproto repo:app.bsky.feed.post?action=create',
  token_endpoint_auth_method: 'none',
  dpop_bound_access_tokens: true,
}
function required(name) {
  if (!process.env[name]) throw Error(`${name} is required`)
  return process.env[name]
}
function json(response, body) {
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}
createServer(async (request, response) => {
  if (request.url === '/sandbox-config.json') {
    return json(response, { appUrl, pdsUrl, plcUrl })
  }
  if (request.url === '/oauth-client-metadata.json') {
    return json(response, metadata)
  }
  const pathname = request.url === '/' || request.url?.startsWith('/callback?') || request.url === '/callback'
    ? '/index.html'
    : request.url || '/index.html'
  const file = join(root, normalize(pathname).replace(/^\/+/, ''))
  if (!file.startsWith(`${root}/`)) {
    response.writeHead(404)
    return response.end()
  }
  try {
    await fs.access(file)
    response.writeHead(200, {
      'content-type': file.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'text/html; charset=utf-8',
    })
    createReadStream(file).pipe(response)
  } catch {
    response.writeHead(404)
    response.end()
  }
}).listen(8080, '0.0.0.0')
