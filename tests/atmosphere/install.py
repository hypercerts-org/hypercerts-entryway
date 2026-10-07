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
        profile_nodes = os.environ.get('ENTRYWAY_PROFILE_NODE_COUNT')
        if profile_nodes and app == 'hypercerts-entryway':
            if profile_nodes not in ['1', '2']:
                raise SystemExit('Invalid profile node count')
            if profile_nodes == '2' and (os.environ.get('DATABASE_BACKEND') != 'postgresql' or os.environ.get('DEPLOYMENT_MODE') != 'multi-node'):
                raise SystemExit('Two-node profile requires PostgreSQL multi-node')
            if suffix == '.yaml':
                extra = (source / 'stacks/entryway-profile-services.yaml').read_text()
                if profile_nodes == '2':
                    extra += (source / 'stacks/entryway-profile-replica.yaml').read_text()
                text = text.replace('\nvolumes:\n', '\n' + extra + '\nvolumes:\n  profile-private: {}\n  entryway-replica-data: {}\n')
                # Browser state is private mounted state, excluded from reports.
                text = text.replace('      - entryway-data:/entryway-data\n', '      - profile-private:/profile\n      - entryway-data:/entryway-data\n')
                text = text.replace('      - database-profile-data:/profile', '      - profile-private:/profile')
            else:
                definition = json.loads(text)
                for route in definition['routes']:
                    if route['service'] == 'entryway':
                        route['service'] = 'profile-ingress'
                definition['services'].append({'service': 'profile-ingress', 'environment': []})
                if profile_nodes == '2':
                    definition['services'].append({'service': 'entryway-replica', 'environment': []})
                text = json.dumps(definition, indent=2) + '\n'
        # Compose paths resolve relative to the generated file in the clone.
        text = text.replace('context: ../..', 'context: ' + json.dumps(str(root)))
        text = text.replace('../artifacts:/app/artifacts:z', os.environ.get('ACCEPTANCE_REPORT_DIR', str(root / 'tests/artifacts')) + ':/app/artifacts:z')
        target = sandbox / 'stacks' / (app + suffix)
        if target.exists() and target.read_text() != text and (sandbox / 'state/manifest.json').exists():
            raise SystemExit(f'Template drift in existing state: {app}; review and use a fresh runtime, not silent overwrite')
        target.write_text(text)
registry_path.write_text(json.dumps(registry, indent=2)+'\n')
shutil.copytree(source / 'examples/entryway-oauth-web-app', sandbox / 'examples/entryway-oauth-web-app', dirs_exist_ok=True)
