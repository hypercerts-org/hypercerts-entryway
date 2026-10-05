// Expected inherited product gap; never relabel the profile itself as passing.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const [path, rawExit, output] = process.argv.slice(2)
const profile = JSON.parse(readFileSync(path, 'utf8'))
assert.equal(Number(rawExit), 2, 'Unexpected interop-profile exit')
assert.equal(profile.moderation.result, 'MISSING_REQUIRED_MODERATION_COORDINATION')
assert.ok([404, 501].includes(profile.moderation.status))
assert.equal(profile.pdsVersion, '0.5.36')
assert.equal(profile.descriptions.length, 3)
for (const description of profile.descriptions) {
  assert.equal(description.status, 200)
  assert.ok(Array.isArray(description.domains) && description.domains.length > 0)
}
writeFileSync(output, JSON.stringify({ rawExit: Number(rawExit), equivalence: 'expected-inherited-gap-only', productReadiness: 'blocked', blocker: profile.moderation.result }, null, 2))
