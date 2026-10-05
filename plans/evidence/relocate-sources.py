"""Mechanical relocation; recorded map is the authoritative original-to-current map."""
from pathlib import Path
import json,os,re
root=Path('.').resolve()
d=json.loads(Path('plans/evidence/feature-move-map.json').read_text())
mapping={e['source']:e['initial_target'] for e in d['files']}
source={old:Path(old).read_text() for old in mapping}
def rewrite(text,old,new):
 def spec(m):
  value=m.group(2)
  if not value.startswith('.'):return m.group(0)
  target=os.path.normpath(os.path.join(os.path.dirname(old),value))
  dist=target.startswith('dist/')
  check=target[5:] if dist else target
  key=check if check in mapping else check[:-3]+'.ts' if check.endswith('.js') and check[:-3]+'.ts' in mapping else None
  if not key:return m.group(0)
  destination=mapping[key]
  if value.endswith('.js') and destination.endswith('.ts'):destination=destination[:-3]+'.js'
  if dist:destination='dist/'+destination
  value=os.path.relpath(destination,os.path.dirname(new) or '.')
  if not value.startswith('.'):value='./'+value
  return m.group(1)+value+m.group(3)
 return re.sub(r"((?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s*)['\"])([^'\"]+)(['\"])",spec,text)
for old,new in mapping.items():
 p=Path(new);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(rewrite(source[old],old,new));Path(old).unlink()
for directory in ['tests','scripts']:
 for p in Path(directory).rglob('*'):
  if not p.is_file() or any(x in p.parts for x in ['.runtime','artifacts','node_modules']):continue
  if p.suffix in ['.mjs','.ts','.json','.yaml','.sh']:
   text=p.read_text();updated=rewrite(text,str(p),str(p))
   for old,new in mapping.items(): updated=updated.replace('dist/'+old,'dist/'+new)
   if updated!=text:p.write_text(updated)
for p in Path('packages').rglob('package.json'):p.unlink()
for p in sorted(Path('packages').rglob('*'),reverse=True):
 if p.is_dir():p.rmdir()
Path('packages').rmdir()
p=Path('package.json');data=json.loads(p.read_text());data.pop('workspaces',None)
for k,v in data['scripts'].items():
 for old,new in mapping.items():v=v.replace('dist/'+old,'dist/'+new)
 v=v.replace('packages scripts tests','src scripts tests');data['scripts'][k]=v
p.write_text(json.dumps(data,indent=2)+'\n')
p=Path('tsconfig.json');data=json.loads(p.read_text());data['include']=['src/**/*.ts','src/**/*.mjs','tests/fixtures/**/*.ts','tests/fixtures/**/*.mjs'];data['exclude']=['dist','node_modules'];p.write_text(json.dumps(data,indent=2)+'\n')
for p in [Path('tests/support/Dockerfile'),Path('tests/support/Dockerfile.browser')]:p.write_text(''.join(l for l in p.read_text().splitlines(True) if not l.startswith('COPY packages/')))
p=Path('docs/source-map.json');original=json.loads(p.read_text());p.write_text(json.dumps({k:{'imported':v,'current':mapping[v]} for k,v in original.items()},indent=2)+'\n')
print('Relocated',len(mapping),'files; rewrote resolved imports and runtime paths')
