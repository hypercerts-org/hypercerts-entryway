import { mkdir, readFile } from 'node:fs/promises'
import { PDS, envToCfg, envToSecrets, readEnv } from '@atproto/pds'

const config = JSON.parse(await readFile(process.env.SPIKE_CONFIG || '/config/config.json', 'utf8'))
const pds = config.pds.find(({ id }) => id === process.env.PDS_ID)
if (!pds) throw new Error(`Unknown PDS_ID: ${process.env.PDS_ID}`)
await mkdir('/data/blobs', { recursive: true })
await mkdir('/data/actors', { recursive: true })

const env = {
  ...readEnv(),
  port: 3000,
  hostname: new URL(pds.url).host,
  serviceDid: pds.did,
  serviceName: `Entryway spike ${pds.id}`,
  dataDirectory: '/data',
  actorStoreDirectory: '/data/actors',
  blobstoreDiskLocation: '/data/blobs',
  blobstoreDiskTmpLocation: '/data/blob-tmp',
  didPlcUrl: config.plcUrl,
  serviceHandleDomains: config.handleDomains,
  plcRotationKeyK256PrivateKeyHex: pds.plcRotationKeyHex,
  jwtSecret: pds.jwtSecret,
  adminPassword: pds.adminPassword,
  entrywayUrl: config.issuer,
  entrywayDid: config.serviceDid,
  entrywayJwtVerifyKeyK256PublicKeyHex: config.jwtPublicHex,
  entrywayPlcRotationKey: config.plcRotationKeyDid,
  entrywayAdminToken: config.adminPassword,
  devMode: true,
  disableSsrfProtection: true,
  rateLimitsEnabled: false,
  inviteRequired: false,
  crawlers: [],
}
// Published PDS code and supported configuration API only; no source patching.
const server = await PDS.create(envToCfg(env), envToSecrets(env))
await server.start()
console.log(`${pds.id} started at ${pds.url}; entryway=${config.issuer}`)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.destroy()
    process.exit(0)
  })
}
