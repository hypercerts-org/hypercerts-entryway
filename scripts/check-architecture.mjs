import { readdirSync, readFileSync } from 'node:fs'
import { resolve, relative, dirname, sep } from 'node:path'
import ts from 'typescript6'
import { pathToFileURL } from 'node:url'

const forbiddenPackages = /^(?:better-auth|better-sqlite3|express|node:https?|https?|@atproto\/xrpc-server)(?:$|\/)/

export function importsIn(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const result = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      result.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

export function coreViolations(source, filename, root, options) {
  const violations = []
  for (const specifier of importsIn(source, filename)) {
    if (forbiddenPackages.test(specifier)) {
      violations.push(`${specifier}: forbidden package`)
      continue
    }
    const resolved = ts.resolveModuleName(specifier, filename, options, ts.sys).resolvedModule?.resolvedFileName
    if (!resolved) {
      if (specifier.startsWith('.') || specifier.startsWith('@'))
        violations.push(`${specifier}: unresolved import`)
      continue
    }
    const target = relative(root, resolve(resolved)).split(sep).join('/')
    if (target.startsWith('infra/') || target.startsWith('features/') ||
        target.includes('entryway-service/') || target.includes('entryway-web/') || target.endsWith('.mjs')) {
      violations.push(`${specifier}: core depends on ${target}`)
    }
  }
  return violations
}

export function checkArchitecture(appRoot) {
  const configPath = ts.findConfigFile(appRoot, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw Error('Missing TypeScript configuration')
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
  if (loaded.error) throw Error('Invalid TypeScript configuration')
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, appRoot)
  if (parsed.errors.length) throw Error('Invalid TypeScript configuration')
  const coreRoot = resolve(appRoot, 'packages/entryway-core/src')
  const sourceRoot = coreRoot
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts')) files.push(path)
    }
  }
  walk(coreRoot)
  const violations = files.flatMap((file) =>
    coreViolations(readFileSync(file, 'utf8'), file, sourceRoot, parsed.options)
      .map((violation) => `${relative(appRoot, file)}: ${violation}`))
  return { files: files.length, violations }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkArchitecture(resolve('.'))
  for (const violation of result.violations) console.error(violation)
  console.log(`Checked ${result.files} core source files; ${result.violations.length} boundary violations`)
  process.exitCode = result.violations.length ? 1 : 0
}
