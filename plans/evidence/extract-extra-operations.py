from pathlib import Path
import re,os
p=Path('src/http/protocol-operations.mjs');s=p.read_text()
def put(path,text):
 p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
helpers=s[s.index('const fail ='):s.index('export async function')].replace('const fail =','export const fail =').replace('const emailAddress =','export const emailAddress =')
put('src/accounts/input.mjs',"import { HttpError } from '../http/http-error.mjs'\n\n"+helpers)
imports="""import { randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto'
import { importJWK, SignJWT } from 'jose'
import * as plc from '@did-plc/lib'
import { cidForLex } from '@atproto/lex-cbor'
"""
chunks=[('src/accounts/challenges.mjs','createProtocolChallenges','challengeDigest','internalAccess',['rateLimit','sendCode','requireCode'],['db','config','accounts']),('src/pds/account-client.mjs','createPdsAccountClient','internalAccess','requestSignup',['pdsCall','choosePds'],['config','accounts']),('src/features/account-registration/signup-proof.mjs','createSignupProof','requestSignup','reserveSigningKey',['requestSignup','verifySignup','requestPhoneVerification','verifyPhone'],['sendCode','requireCode']),('src/plc/operations.mjs','createPlcOperations','reserveSigningKey','checkAccountStatus',['reserveSigningKey','requestPlcOperationSignature','signPlcOperation','submitPlcOperation'],['db','config','accounts','sendCode','requireCode','pdsCall','choosePds']),('src/features/account-registration/invites.mjs','createInvites','createInviteCode','registerScope',['createInviteCode','getAccountInviteCodes','reserveInvite','completeInvite'],['db','config','accounts']),('src/features/oauth-authorization/scope-reference.mjs','createScopeReferences','registerScope','sendEmail',['registerScope','dereferenceScope'],['db']),('src/mail/admin-message.mjs','createAdminMessage','sendEmail',None,['sendEmail'],['db'])]
mountimports=[];calls=[]
for path,fn,start,end,exports,args in chunks:
 body=s[s.index('  const '+start+' ='):s.index('  const '+end+' =') if end else s.index('  return {\n    rateLimit,')]
 if start=='internalAccess':body="  const jwtKey = await importJWK(config.jwtJwk, 'ES256K')\n"+body
 # all namespaces remain one database transaction; no raw sqlite escapes.
 body=body.replace('db.sqlite.transaction(', 'db.transact(').replace('    })()','    })').replace('  })()','  })')
 rel=lambda t: ('./' if not os.path.relpath(t,Path(path).parent).startswith('.') else '')+os.path.relpath(t,Path(path).parent)
 put(path,imports+"import { fail, emailAddress } from '"+rel('src/accounts/input.mjs')+"'\nimport { xrpc } from '"+rel('src/pds/client.mjs')+"'\n\nexport async function "+fn+'({ '+', '.join(args)+' }) {\n'+body+'  return { '+', '.join(exports)+' }\n}\n')
 mountimports.append("import { "+fn+" } from './"+path[4:]+"'")
 calls.append('  Object.assign(operations, await '+fn+'({ db, config, accounts, ...operations }))')
put('src/compose-protocol-operations.mjs','\n'.join(mountimports)+'\n\nexport async function createEntrywayExtras({ db, config, accounts }) {\n  const operations = {}\n'+'\n'.join(calls)+"\n  return { ...operations, checkAccountStatus: (row) => operations.pdsCall(row, 'com.atproto.server.checkAccountStatus') }\n}\n")
p.unlink()
for folder in ['src','tests']:
 for p in Path(folder).rglob('*.mjs'):
  if any(x in p.parts for x in ['.runtime','artifacts']):continue
  text=p.read_text()
  def rewrite(m):
   old=m.group(1)
   if not old.endswith('/http/protocol-operations.mjs'):return m.group(0)
   base='dist/' if '/dist/' in old else ''
   value=os.path.relpath(base+'src/compose-protocol-operations.mjs',p.parent)
   return "'"+(value if value.startswith('.') else './'+value)+"'"
  updated=re.sub(r"'([^']+)'",rewrite,text)
  if updated!=text:p.write_text(updated)
