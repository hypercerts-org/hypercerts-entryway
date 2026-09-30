import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

let failed = false
function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'artifacts', '.runtime', '.git', 'atmosphereinabox'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) checkDirectory(path)
    else if (entry.name.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' })
      if (result.status !== 0) failed = true
    }
  }
}
for (const directory of ['packages', 'scripts', 'tests']) checkDirectory(directory)
process.exitCode = failed ? 1 : 0
