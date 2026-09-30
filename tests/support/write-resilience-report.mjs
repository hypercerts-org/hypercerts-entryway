// The host controls Docker lifecycle; the managed test container owns artifacts.
import { mkdir, writeFile } from 'node:fs/promises'

let input = ''
for await (const chunk of process.stdin) {
  input += chunk
  if (input.length > 1_000_000) throw new Error('Resilience report exceeds size limit')
}
const report = JSON.parse(input)
if (!report || !['passed', 'failed'].includes(report.status) ||
    !Array.isArray(report.phases) || !report.restoration ||
    typeof report.finishedAt !== 'string') {
  throw new Error('Invalid resilience report')
}
const directory = process.env.SPIKE_ARTIFACTS ?? '/app/artifacts'
await mkdir(directory, { recursive: true })
await writeFile(`${directory}/resilience.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
