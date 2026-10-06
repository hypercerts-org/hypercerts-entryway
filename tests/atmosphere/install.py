"""Register repository-owned consumer templates without patching AiaB implementation."""
import json
import os
import pathlib
import shutil
import sys
root, sandbox = map(pathlib.Path, sys.argv[1:])
source = root / 'tests/atmosphere'
registry_path = sandbox / 'stacks/components.json'
registry = json.loads(registry_path.read_text())
for app in ['hypercerts-entryway','entryway-fixtures','entryway-oauth-web-app','entryway-browser-client']:
    entry = {'id':app,'file':f'stacks/{app}.yaml','application':app,'definition':f'stacks/{app}.definition.json'}
    existing = [item for item in registry if item.get('id') == app]
    if len(existing) > 1 or (existing and existing[0] != entry):
        raise SystemExit(f'Conflicting managed application registration: {app}')
    if not existing:
        registry.append(entry)
    for suffix in ['.yaml','.definition.json']:
        text = (source / 'stacks' / (app + suffix)).read_text()
        # Compose paths resolve relative to the generated file in the clone.
        text = text.replace('context: ../..', 'context: ' + json.dumps(str(root)))
        text = text.replace('../artifacts:/app/artifacts:z', os.environ.get('ACCEPTANCE_REPORT_DIR', str(root / 'tests/artifacts')) + ':/app/artifacts:z')
        target = sandbox / 'stacks' / (app + suffix)
        if target.exists() and target.read_text() != text and (sandbox / 'state/manifest.json').exists():
            raise SystemExit(f'Template drift in existing state: {app}; review and use a fresh runtime, not silent overwrite')
        target.write_text(text)
registry_path.write_text(json.dumps(registry, indent=2)+'\n')
shutil.copytree(source / 'examples/entryway-oauth-web-app', sandbox / 'examples/entryway-oauth-web-app', dirs_exist_ok=True)
