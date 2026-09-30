import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript6'
import { checkArchitecture, coreViolations } from '../../scripts/check-architecture.mjs'

test('core dependencies stay inside core and shared', () => {
  const result = checkArchitecture(resolve('.'))
  assert.ok(result.files > 0)
  assert.deepEqual(result.violations, [])
})

test('core dependency check resolves aliases and rejects storage and HTTP imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'entryway-architecture-'))
  try {
    const coreFile = join(root, 'src/core/example.ts')
    const infraFile = join(root, 'src/infra/storage/sql.ts')
    mkdirSync(dirname(coreFile), { recursive: true })
    mkdirSync(dirname(infraFile), { recursive: true })
    writeFileSync(infraFile, 'export const x = 1\n')
    const source = "import { x } from '@storage/sql.js'\nimport express from 'express'\n"
    const violations = coreViolations(source, coreFile, join(root, 'src'), {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      baseUrl: root,
      paths: { '@storage/*': ['src/infra/storage/*'] },
    })
    assert.ok(violations.some((value) => value.includes('infra/storage/sql.ts')))
    assert.ok(violations.some((value) => value.includes('express: forbidden package')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
