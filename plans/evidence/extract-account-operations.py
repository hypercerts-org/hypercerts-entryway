from pathlib import Path
p=Path('src/accounts/create-accounts.mjs');s=p.read_text()
def put(path,text):
 p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
error=s[s.index('export class HttpError'):s.index('export async function xrpc')]
xrpc=s[s.index('export async function xrpc'):s.index('export async function createAccounts')]
put('src/http/http-error.mjs',error)
put('src/pds/client.mjs',"import { HttpError } from '../http/http-error.mjs'\n\n"+xrpc)
start=s.index('  const claimHandle =');end=s.index('  const pending =')
primitives=s[start:end]
exports=['claimHandle','get','list','save','pdsFor','admin','journal','assertNoMigration','validateHandle','serialized']
put('src/accounts/primitives.mjs',"import { ensureValidHandle } from '@atproto/syntax'\nimport { HttpError } from '../http/http-error.mjs'\nimport { xrpc } from '../pds/client.mjs'\n\nexport function createAccountPrimitives({ db, config, storage }) {\n"+primitives+'  return { '+', '.join(exports)+', storage }\n}\n')
creation=s[s.index('  const pending ='):s.index('  const updateHandle =')]
put('src/features/account-registration/create-account.mjs',"import * as plc from '@did-plc/lib'\nimport { HttpError } from '../../http/http-error.mjs'\nimport { xrpc } from '../../pds/client.mjs'\n\nexport function createRegistration({ db, config, rotation, storage, get, save, claimHandle, validateHandle, journal }) {\n"+creation+'  return { create, setProvisionPolicy }\n}\n')
for name,end,fn,loc in [('updateHandle','setStatus','createHandleChange','handle-change/change-handle'),('setStatus','deleteAccount','createStatusChange','account-settings/change-status'),('deleteAccount','reconcile','createDeletion','account-deletion/delete-account')]:
 block=s[s.index('  const '+name+' ='):s.index('  const '+end+' =')]
 args={'updateHandle':'db, config, storage, get, save, claimHandle, validateHandle, journal, serialized, assertNoMigration, admin, plcClient, rotation','setStatus':'get, save, journal, serialized, assertNoMigration, admin','deleteAccount':'get, save, journal, serialized, assertNoMigration, admin'}[name]
 put('src/features/'+loc+'.mjs',"import { HttpError } from '../../http/http-error.mjs'\n\nexport function "+fn+'({ '+args+' }) {\n'+block+'  return '+name+'\n}\n')
reconcile=s[s.index('  const reconcile ='):s.index('  return {\n    get,')]
put('src/reconcile-accounts.mjs','export function createAccountReconciler({ db, list, get, create, updateHandle, setStatus, deleteAccount }) {\n'+reconcile+'  return reconcile\n}\n')
put('src/compose-accounts.mjs',"""import * as plc from '@did-plc/lib'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createSqliteAccountStorage } from './database/sqlite/sqlite-account-storage.js'
import { createAccountPrimitives } from './accounts/primitives.mjs'
import { createRegistration } from './features/account-registration/create-account.mjs'
import { createHandleChange } from './features/handle-change/change-handle.mjs'
import { createStatusChange } from './features/account-settings/change-status.mjs'
import { createDeletion } from './features/account-deletion/delete-account.mjs'
import { createAccountReconciler } from './reconcile-accounts.mjs'

// Composition only: each operation and its mutable state live with its feature.
export async function createAccounts({ db, config }) {
  const rotation = await Secp256k1Keypair.import(Buffer.from(config.plcRotationKeyHex, 'hex'))
  const plcClient = new plc.Client(config.plcUrl)
  const storage = createSqliteAccountStorage(db.sqlite, config.pds)
  const shared = createAccountPrimitives({ db, config, storage })
  const context = { db, config, rotation, plcClient, ...shared }
  const registration = createRegistration(context)
  const operations = {
    ...registration,
    updateHandle: createHandleChange(context),
    setStatus: createStatusChange(context),
    deleteAccount: createDeletion(context),
  }
  return { ...shared, ...operations, rotation, plcClient,
    reconcile: createAccountReconciler({ db, ...shared, ...operations }) }
}
""")
p.unlink()
# Rewrite named imports by symbol instead of leaving a forwarding facade.
import re,os
for folder in ['src','tests']:
 for p in Path(folder).rglob('*.mjs'):
  if any(x in p.parts for x in ['.runtime','artifacts']):continue
  text=p.read_text()
  def change(m):
   names=[x.strip() for x in m.group(1).split(',')];old=m.group(2)
   if not old.endswith('/accounts/create-accounts.mjs'):return m.group(0)
   base='dist/' if '/dist/' in old else ''
   out=[]
   for name in names:
    target={'HttpError':'src/http/http-error.mjs','xrpc':'src/pds/client.mjs','createAccounts':'src/compose-accounts.mjs'}[name]
    path=os.path.relpath(base+target,str(p.parent));path=path if path.startswith('.') else './'+path
    out.append("import { "+name+" } from '"+path+"'")
   return '\n'.join(out)
  text=re.sub(r"import \{ ([^}]+) \} from '([^']+)'",change,text)
  p.write_text(text)
