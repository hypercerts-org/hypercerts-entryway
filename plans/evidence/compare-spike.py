#!/usr/bin/env python3
"""Read-only source inventory. Writes JSON to stdout; no application execution."""
import pathlib, json, re, hashlib, collections
T=pathlib.Path('/home/evelyn/git/hypercerts/hypercerts-entryway')
S=pathlib.Path('/home/evelyn/git/hypercerts/entryway/next-spike')
roots={'main':S/'app/src','interop':S/'.worktrees/interop/app/src','verification':S/'.worktrees/verification-5-8/app/src'}
mapping=json.loads((T/'docs/source-map.json').read_text())
pattern=re.compile(r'''(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"\n]+)\2''')
def norm(s):return pattern.sub(lambda m:m[1]+m[2]+'<specifier>'+m[2],s)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
rows=[];counts={k:collections.Counter() for k in roots}
for source,target in mapping.items():
 p=T/target;row={'source':source,'target':target,'targetSha256':sha(p) if p.exists() else None,'comparisons':{}}
 for name,root in roots.items():
  q=root/source
  if not p.exists() or not q.exists():status='missing'
  elif p.read_bytes()==q.read_bytes():status='identical'
  elif norm(p.read_text())==norm(q.read_text()):status='specifier-only'
  else:status='semantic-review'
  counts[name][status]+=1;row['comparisons'][name]={'status':status,'sourceSha256':sha(q) if q.exists() else None}
 rows.append(row)
print(json.dumps({'targetRoot':str(T),'targetCommit':'41568b27dc1c0bf7133bc66b11beb21d0c493c23','sourceRoots':{k:str(v) for k,v in roots.items()},'method':'Byte comparison then normalize only import/export/dynamic-import specifier strings; inspect all semantic-review diffs manually. Does not establish runtime behavior.','counts':counts,'files':rows},indent=2))
