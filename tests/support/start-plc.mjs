import * as plc from '@did-plc/server'

const db = plc.Database.postgres({
  url: process.env.DATABASE_URL || 'postgresql://spike:spike-local-only@postgres:5432/plc',
})
await db.migrateToLatestOrThrow()
const server = plc.PlcServer.create({ db, port: 2582 })
await server.start()
console.log('Local PLC directory started on :2582')
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.destroy()
    process.exit(0)
  })
}
