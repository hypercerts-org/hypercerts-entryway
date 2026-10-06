import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SMTPServer } from 'smtp-server'

const captureDirectory = process.env.MAIL_CAPTURE_DIR ?? '/capture'
const port = Number(process.env.MAIL_CAPTURE_PORT ?? 2525)
const retentionMs = 15 * 60_000

await mkdir(captureDirectory, { recursive: true })

async function pruneCaptures() {
  const names = await readdir(captureDirectory)
  await Promise.all(
    names.filter((name) => name.endsWith('.json')).map(async (name) => {
      const path = join(captureDirectory, name)
      try {
        const capture = JSON.parse(await readFile(path, 'utf8'))
        if (Number(capture.expiresAt) <= Date.now()) await unlink(path)
      } catch {
        await unlink(path).catch(() => undefined)
      }
    }),
  )
}

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['AUTH', 'STARTTLS'],
  size: 1_000_000,
  onData(stream, session, callback) {
    const chunks = []
    let bytes = 0
    stream.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes <= 1_000_000) chunks.push(chunk)
    })
    stream.on('error', () => callback(new Error('Capture stream failed')))
    stream.on('end', async () => {
      if (bytes > 1_000_000) return callback(new Error('Message is too large'))
      const capturedAt = Date.now()
      const message = {
        capturedAt,
        expiresAt: capturedAt + retentionMs,
        mailFrom: session.envelope.mailFrom?.address ?? '',
        recipients: session.envelope.rcptTo.map(({ address }) => address),
        raw: Buffer.concat(chunks).toString('utf8'),
      }
      try {
        await writeFile(join(captureDirectory, `${capturedAt}-${randomUUID()}.json`), JSON.stringify(message), {
          mode: 0o600,
          flag: 'wx',
        })
        callback()
      } catch {
        callback(new Error('Private mail capture is unavailable'))
      }
    })
  },
})

server.on('error', () => process.exitCode = 1)
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'mail_capture.ready', port }))
})
const pruneTimer = setInterval(() => void pruneCaptures(), 60_000).unref()
await pruneCaptures()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(pruneTimer)
    server.close(() => process.exit(0))
  })
}
