from pathlib import Path
import re,os
p=Path('src/http/xrpc.mjs');s=p.read_text();start=s.index("  app.get('/xrpc/com.atproto.server.describeServer'");end=s.index('  return { authenticate }')
head=s[:start]
head=head.replace('export async function mountXrpc(', 'export async function createProtocolRouting(')
head=head.replace('session?.user?.emailVerified','session?.emailVerified').replace('session.user.email','session.email').replace('session.user.id','session.userId').replace('session.session.id','session.sessionId').replace('session.session.createdAt','session.authenticatedAt')
Path('src/http/protocol-authentication.mjs').write_text(head+'  return { authenticate, route, authenticatedRoute, migrationPrincipal, admin }\n}\n')
body=s[start:end];positions=[m.start() for m in re.finditer(r'^  (?:app\.(?:get|post)\(|route\(|authenticatedRoute\(|for \(const \[name, status\])',body,re.M)]+[len(body)]
groups={}
def owner(block):
 first=block.splitlines()[0].lower()
 if 'for (const [name' in first:return 'features/account-settings'
 for needle,dest in [('identity.resolvehandle','features/handle-change'),('identity.updatehandle','features/handle-change'),('server.getsession','features/email-login'),('signup','features/account-registration'),('/migration/','features/pds-migration'),('server.createaccount','features/account-registration'),('server.createsession','features/email-login'),('server.refreshsession','features/email-login'),('server.deletesession','features/email-login'),('apppassword','features/connected-apps'),('emailconfirmation','features/account-settings'),('confirmemail','features/account-settings'),('emailupdate','features/account-settings'),('updateemail','features/account-settings'),('passwordreset','features/account-recovery'),('resetpassword','features/account-recovery'),('accountdelete','features/account-deletion'),('deleteaccount','features/account-deletion'),('checkaccountstatus','features/account-settings'),('reservesigningkey','plc'),('plcoperation','plc'),('invite','features/account-registration'),('phoneverification','features/account-registration'),('scope','features/oauth-authorization'),('updateaccountemail','features/account-settings'),('updateaccountpassword','features/account-settings'),('sendemail','mail')]:
  if needle in first:return dest
 return 'http'
for a,b in zip(positions,positions[1:]):
 block=body[a:b].replace('session?.user?.emailVerified','session?.emailVerified').replace('session?.user?.email','session?.email').replace('session.user.email','session.email').replace('session.user.id','session.userId')
 groups.setdefault(owner(block),[]).append(block)
imports=[];calls=[];deps=['app','db','config','accounts','oauth','legacy','security','extras','migration','reconcile','authenticate','route','authenticatedRoute','migrationPrincipal','admin']
for dest,blocks in groups.items():
 body=''.join(blocks);name='mount'+''.join(p.title() for p in dest.split('/')[-1].split('-'))+'Xrpc'
 used=[d for d in deps if re.search(r'\b'+d+r'\b',body)]
 path=Path('src/'+dest+'/xrpc-routes.mjs');path.parent.mkdir(parents=True,exist_ok=True)
 rel=os.path.relpath('src/http/http-error.mjs',path.parent);rel=rel if rel.startswith('.') else './'+rel
 path.write_text("import { HttpError } from '"+rel+"'\n\nexport function "+name+'({ '+', '.join(used)+' }) {\n'+body+'}\n')
 imports.append("import { "+name+" } from './"+dest+"/xrpc-routes.mjs'");calls.append('  '+name+'({ ...services, ...routing })')
Path('src/compose-protocol.mjs').write_text("import { createProtocolRouting } from './http/protocol-authentication.mjs'\n"+'\n'.join(imports)+'\n\nexport async function mountXrpc(services) {\n  const routing = await createProtocolRouting(services)\n'+'\n'.join(calls)+'\n  return { authenticate: routing.authenticate }\n}\n')
p.unlink()
for folder in ['src','tests']:
 for p in Path(folder).rglob('*.mjs'):
  if any(x in p.parts for x in ['.runtime','artifacts']):continue
  text=p.read_text()
  def change(m):
   names=[n.strip() for n in m.group(1).split(',')];old=m.group(2)
   if not old.endswith('/http/xrpc.mjs'):return m.group(0)
   base='dist/' if '/dist/' in old else ''
   result=[]
   for name in names:
    target='src/compose-protocol.mjs' if name=='mountXrpc' else 'src/http/protocol-authentication.mjs'
    rel=os.path.relpath(base+target,p.parent);rel=rel if rel.startswith('.') else './'+rel
    result.append("import { "+name+" } from '"+rel+"'")
   return '\n'.join(result)
  updated=re.sub(r"import \{ ([^}]+) \} from '([^']+)'",change,text)
  if updated!=text:p.write_text(updated)
print('Extracted',sum(map(len,groups.values())),'route registrations into',len(groups),'owners')
