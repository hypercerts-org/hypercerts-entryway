// Explicitly disruptive controller. Run only after browser/contract tests finish:
//   node tests/support/resilience.mjs --run
// Every Docker command uses the Entryway sandbox Compose project and retains volumes.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.argv.length !== 3 || process.argv[2] !== '--run') {
  console.error(
    'This harness stops entryway and restarts the Entryway sandbox services. Finish browser/contract tests, then run: node tests/support/resilience.mjs --run',
  )
  process.exit(2)
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cwd = process.env.ENTRYWAY_SANDBOX_ROOT ?? resolve(root, 'tests/.runtime/atmosphereinabox')
const artifactDir = process.env.ENTRYWAY_E2E_REPORT_DIR ?? resolve(root, 'tests/artifacts')
const project = process.env.ENTRYWAY_E2E_PROJECT ?? 'hypercerts-entryway'
assert.match(project, /^hypercerts-entryway(-[a-z0-9_-]+)?$/)
const groups = [['postgres', 'dns', 'gateway'], ['plc'], ['entryway'], ['pds1', 'pds2']]
const services = groups.flat()
const report = {
  status: 'running',
  startedAt: new Date().toISOString(),
  phases: [],
  commands: [],
  restoration: { required: false, succeeded: false, errors: [] },
}
let privateDir,
  disrupted = false,
  interrupted = false,
  currentChild

function docker(args, { allowInterrupted = false, input } = {}) {
  if (interrupted && !allowInterrupted)
    return Promise.reject(new Error('Resilience run interrupted'))
  return new Promise((resolveResult, reject) => {
    const start = Date.now()
    const argv = ['compose', '--project-name', project, '--file', 'compose.yaml', ...args]
    const child = spawn('docker', argv, { cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    if (input !== undefined) child.stdin.end(input)
    currentChild = child
    let stdout = '',
      stderr = ''
    const collect = (old, chunk) => (old + chunk.toString()).slice(-200_000)
    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk)
      if (args.includes('tests/contracts/outage-probe.mjs')) process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk)
    })
    let killTimer
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    }, 90_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (currentChild === child) currentChild = null
      report.commands.push({
        args: argv,
        exitCode: code,
        signal,
        durationMs: Date.now() - start,
        ...(code !== 0 ? { stderr: stderr.slice(-8000), stdout: stdout.slice(-8000) } : {}),
      })
      if (code === 0) resolveResult(stdout)
      else
        reject(
          new Error(
            `Docker compose ${args[0]} failed (exit ${code ?? signal}): ${stderr.slice(-2000)}`,
          ),
        )
    })
  })
}
function parsePs(output) {
  const trimmed = output.trim()
  if (!trimmed) return []
  return trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed.split('\n').map((line) => JSON.parse(line))
}
async function waitHealthy(expected, allowInterrupted = false) {
  const deadline = Date.now() + 60_000
  let last = []
  do {
    last = parsePs(await docker(['ps', '--all', '--format', 'json'], { allowInterrupted }))
    if (
      expected.every((name) =>
        last.some(
          (row) =>
            row.Service === name &&
            row.State === 'running' &&
            (!row.Health || row.Health === 'healthy'),
        ),
      )
    )
      return
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
  } while (Date.now() < deadline)
  throw new Error(
    `Services did not become healthy: ${JSON.stringify(last.filter((row) => expected.includes(row.Service)).map(({ Service, State, Health }) => ({ Service, State, Health })))}`,
  )
}
async function startGroups(allowInterrupted = false) {
  for (const group of groups) {
    await docker(['start', ...group], { allowInterrupted })
    await waitHealthy(group, allowInterrupted)
  }
}
async function phase(name) {
  console.log(`Resilience phase: ${name}`)
  let phaseError
  try {
    await docker([
      'run',
      '--rm',
      '--no-deps',
      '--volume',
      `${privateDir}:/resilience-private:z`,
      '--env',
      `OUTAGE_PHASE=${name}`,
      'test',
      'node',
      'tests/contracts/outage-probe.mjs',
    ])
  } catch (error) {
    phaseError = error
  }
  try {
    const result = JSON.parse(await readFile(join(artifactDir, `resilience-${name}.json`), 'utf8'))
    assert.ok(
      new Date(result.startedAt).getTime() >= new Date(report.startedAt).getTime(),
      'Phase artifact must belong to this run',
    )
    report.phases.push(result)
    assert.equal(
      result.status,
      'passed',
      `Resilience phase ${name} failed: ${result.error?.message ?? 'see phase artifact'}`,
    )
  } catch (error) {
    phaseError ??= error
  }
  if (phaseError) throw phaseError
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (interrupted) return
    interrupted = true
    currentChild?.kill('SIGTERM')
    console.error('Interrupted; restoring Entryway sandbox services before exit.')
  })

try {
  await mkdir(artifactDir, { recursive: true })
  const running = parsePs(await docker(['ps', '--all', '--format', 'json']))
  assert.ok(
    !running.some((row) => ['browser', 'test'].includes(row.Service) && row.State === 'running'),
    'Do not run resilience checks while browser/contract tests are running',
  )
  assert.ok(
    services.every((name) =>
      running.some((row) => row.Service === name && row.State === 'running'),
    ),
    'Start the complete Entryway sandbox before resilience checks',
  )
  await waitHealthy(services)
  privateDir = await mkdtemp(join(tmpdir(), 'entryway-resilience-'))
  await phase('before')
  disrupted = true
  report.restoration.required = true
  console.log('Stopping entryway; PDS repository services remain running.')
  await docker(['stop', '--timeout', '10', 'entryway'])
  await phase('outage')
  await docker(['start', 'entryway'])
  await waitHealthy(['entryway'])
  await phase('after')
  console.log('Restarting the complete local stack with persistent volumes retained.')
  await docker(['stop', '--timeout', '10', ...[...services].reverse()])
  await startGroups()
  await phase('restart')
  report.restoration.succeeded = true
  disrupted = false
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  if (disrupted) {
    // Continue recovery through every dependency group even if one fails, and
    // record every failure. Recovery never turns a failed probe into a pass.
    for (const group of groups) {
      try {
        await docker(['start', ...group], { allowInterrupted: true })
        await waitHealthy(group, true)
      } catch (error) {
        report.restoration.errors.push({ services: group, message: error.message })
      }
    }
    report.restoration.succeeded = report.restoration.errors.length === 0
  }
  if (privateDir) {
    try {
      await rm(privateDir, { recursive: true, force: true })
    } catch (error) {
      report.privateStateCleanupError = error.message
      report.status = 'failed'
      process.exitCode = 1
    }
  }
  if (interrupted || report.restoration.errors.length) {
    report.status = 'failed'
    process.exitCode = 1
  }
  report.finishedAt = new Date().toISOString()
  await docker(
    ['run', '--rm', '--no-deps', '-T', 'test', 'node', 'tests/support/write-resilience-report.mjs'],
    { allowInterrupted: true, input: JSON.stringify(report) + '\n' },
  )
  console.log(
    JSON.stringify({
      status: report.status,
      phases: report.phases.map(({ phase, status }) => ({ phase, status })),
      restored: report.restoration.succeeded,
      artifact: join(artifactDir, 'resilience.json'),
    }),
  )
}
