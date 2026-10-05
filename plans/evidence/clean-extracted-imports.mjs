import ts from 'typescript6'
import { readFileSync, writeFileSync } from 'node:fs'
const files = ['src/accounts/challenges.mjs','src/pds/account-client.mjs','src/features/account-registration/signup-proof.mjs','src/plc/operations.mjs','src/features/account-registration/invites.mjs','src/features/oauth-authorization/scope-reference.mjs','src/mail/admin-message.mjs','src/features/account-registration/xrpc-routes.mjs','src/features/connected-apps/xrpc-routes.mjs','src/features/email-login/xrpc-routes.mjs','src/features/account-recovery/xrpc-routes.mjs','src/features/account-deletion/xrpc-routes.mjs','src/features/pds-migration/xrpc-routes.mjs','src/features/oauth-authorization/xrpc-routes.mjs','src/plc/xrpc-routes.mjs','src/http/xrpc-routes.mjs']
for (const file of files) {
  let text = readFileSync(file, 'utf8')
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const used = new Set()
  const visit = node => { if (ts.isImportDeclaration(node)) return; if (ts.isIdentifier(node)) used.add(node.text); ts.forEachChild(node, visit) }
  visit(ast)
  const edits = []
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !node.importClause) continue
    const clause = node.importClause, parts = []
    if (clause.name && used.has(clause.name.text)) parts.push(clause.name.text)
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings) && used.has(bindings.name.text)) parts.push(`* as ${bindings.name.text}`)
    if (bindings && ts.isNamedImports(bindings)) {
      const names = bindings.elements.filter(x => used.has(x.name.text)).map(x => x.getText(ast))
      if (names.length) parts.push(`{ ${names.join(', ')} }`)
    }
    edits.push({ start: node.getStart(ast), end: node.end, value: parts.length ? `import ${parts.join(', ')} from ${node.moduleSpecifier.getText(ast)};` : '' })
  }
  for (const edit of edits.reverse()) text = text.slice(0,edit.start)+edit.value+text.slice(edit.end)
  writeFileSync(file,text)
}
console.log(`Removed unused copied imports from ${files.length} extracted modules`)
