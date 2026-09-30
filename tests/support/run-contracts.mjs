import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const files = readdirSync('tests/contracts').filter(name => name.endsWith('.test.mjs')).sort()
const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=artifacts/contracts-junit.xml', ...files.map(name => `tests/contracts/${name}`)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
