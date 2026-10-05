from pathlib import Path
import json,re,hashlib
p=Path('plans/evidence/feature-move-map.json');d=json.loads(p.read_text())
replacements={
'src/accounts/create-accounts.mjs':['src/compose-accounts.mjs','src/accounts/primitives.mjs','src/features/account-registration/create-account.mjs','src/features/handle-change/change-handle.mjs','src/features/account-settings/change-status.mjs','src/features/account-deletion/delete-account.mjs','src/reconcile-accounts.mjs','src/http/http-error.mjs','src/pds/client.mjs'],
'src/http/protocol-operations.mjs':['src/compose-protocol-operations.mjs','src/accounts/input.mjs','src/accounts/challenges.mjs','src/pds/account-client.mjs','src/features/account-registration/signup-proof.mjs','src/plc/operations.mjs','src/features/account-registration/invites.mjs','src/features/oauth-authorization/scope-reference.mjs','src/mail/admin-message.mjs'],
'src/http/xrpc.mjs':['src/compose-protocol.mjs','src/http/protocol-authentication.mjs',*[str(p) for p in Path('src').rglob('xrpc-routes.mjs')]],
'src/accounts/security.mjs':['src/compose-account-security.mjs','src/accounts/security-primitives.mjs','src/accounts/change-email-authority.mjs','src/database/authentication-state.port.ts','src/database/sqlite/account-authority.mjs','src/features/account-settings/security.mjs','src/features/account-recovery/recover-account.mjs','src/features/account-deletion/authorize-deletion.mjs','src/features/pds-migration/proof.mjs'],
'src/features/account-settings/page.mjs':['src/compose-account-ui.mjs','src/http/account-console.mjs','src/ui/account-forms.mjs',*[str(p) for p in Path('src/features').rglob('page.mjs') if p.parent.name not in ['email-login','account-registration']],*[str(p) for p in Path('src/features').rglob('actions.mjs')]],
'src/authentication/better-auth.mjs':['src/authentication/better-auth.mjs','src/authentication/port.ts','src/compose-authentication.mjs','src/http/browser-flow.mjs','src/ui/html.mjs','src/features/email-login/routes.mjs','src/features/email-login/page.mjs','src/features/account-registration/page.mjs','src/features/account-registration/signup-routes.mjs','src/features/oauth-authorization/consent.mjs','src/features/oauth-authorization/redirect.mjs','src/features/oauth-authorization/authorization-routes.mjs'],
'src/main.mjs':['src/main.mjs','src/app.mjs','src/config.mjs'],
'src/http/errors.ts':['src/accounts/errors.ts'],
'src/features/external-migration/integrations.ts':['src/features/external-migration/import-account.ts','src/pds/migration-client.ts','tests/fixtures/source-client.ts'],
'src/features/external-migration/validate-integration.ts':['src/features/external-migration/import-account.ts','src/pds/migration-client.ts','tests/fixtures/source-client.ts'],
'src/database/custody.port.ts':['src/database/custody.port.ts','src/plc/signing.ts','tests/fixtures/source-handoff.ts'],
'src/mail/types.ts':['src/mail/types.ts','src/mail/port.ts','src/database/mail-outbox.port.ts'],
}
def description(path):
 text=Path(path).read_text()
 return {'path':path,'exports':re.findall(r'export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+(\w+)',text),'sha256':hashlib.sha256(text.encode()).hexdigest()}
for e in d['files']:
 targets=replacements.get(e['initial_target'],[e['initial_target']]);assert all(Path(x).is_file() for x in targets),targets
 e['targets']=[description(x) for x in dict.fromkeys(targets)]
 e['disposition']='behavior extracted; forbidden non-boundary ports removed in favor of concrete implementations' if e['initial_target'] in ['src/features/external-migration/integrations.ts','src/features/external-migration/validate-integration.ts','src/database/custody.port.ts'] else 'preserved and assigned to concrete owners'
d['status']='implemented source ownership; validation and known product gaps are recorded separately in execution-ledger.md'
d['current_routes']=[];d['current_transactions']=[]
for file in sorted(Path('src').rglob('*')):
 if not file.is_file() or file.suffix not in ['.ts','.mjs'] or '.test.' in file.name:continue
 text=file.read_text()
 for m in re.finditer(r"(?:\bapp\.(get|post)\(\s*|(?:authenticatedRoute|route)\(\s*['\"](get|post)['\"],\s*)['\"]([^'\"]+)['\"]",text):
  d['current_routes'].append({'method':m.group(1) or m.group(2),'path':m.group(3),'owner':str(file),'line':text[:m.start()].count('\n')+1})
 for i,line in enumerate(text.splitlines(),1):
  if '.transaction(' in line:d['current_transactions'].append({'owner':str(file),'line':i,'operation':line.strip()})
d['dynamic_routes']=[{'path':'/account/:action','dispatcher':'src/http/account-console.mjs','action_owners':[str(p) for p in sorted(Path('src/features').rglob('actions.mjs'))],'fallback':'src/compose-account-ui.mjs'},{'method':'post','paths':['/xrpc/com.atproto.server.activateAccount','/xrpc/com.atproto.server.deactivateAccount'],'owner':'src/features/account-settings/xrpc-routes.mjs'}]
d['workers']=[{'name':'startup mail retry','owner':'src/main.mjs'},{'name':'periodic mail retry','owner':'src/main.mjs'},{'name':'periodic serialized reconciliation','owner':'src/main.mjs','operations':['src/reconcile-accounts.mjs','src/features/pds-migration/move-between-pds.mjs']},{'name':'per-account mutation serialization','owner':'src/accounts/primitives.mjs'},{'name':'security operation serialization','owner':'src/accounts/security-primitives.mjs'}]
p.write_text(json.dumps(d,indent=2)+'\n')
lookup={e['source']:[x['path'] for x in e['targets']] for e in d['files']}
p=Path('docs/source-map.json');mapping=json.loads(p.read_text())
for original,entry in mapping.items():entry['current']=lookup[entry['imported']]
p.write_text(json.dumps(mapping,indent=2)+'\n')
owned=[]
for p in sorted(Path('src').rglob('*.mjs')):
 parts=p.parts;owner=parts[2] if len(parts)>2 and parts[1]=='features' else parts[1] if len(parts)>2 else 'application composition/lifecycle'
 owned.append({'path':str(p),'owner':owner,'kind':'co-located contract test' if '.test.' in p.name else 'preserved/extracted MJS; checkJs remains false'})
Path('docs/source-ownership.json').write_text(json.dumps({'note':'MJS ownership, not a claim of full strict typed conversion','files':owned},indent=2)+'\n')
print('Reconciled',len(d['files']),'source mappings,',len(owned),'owned MJS files,',len(d['current_routes']),'literal route registrations and',len(d['current_transactions']),'SQLite transaction sites')
