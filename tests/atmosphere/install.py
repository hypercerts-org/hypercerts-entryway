"""Register repository-owned consumer templates without patching AiaB implementation."""
import json
import os
import pathlib
import shutil
import sys
from textwrap import indent
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
        if app == 'hypercerts-entryway' and suffix == '.yaml' and os.environ.get('ENTRYWAY_LATE_CUTOVER') == '1':
            start = text.index('  pds1:\n')
            end = text.index('  pds2:\n', start)
            service = text[start:end]
            launcher = root / 'tests/support/start-pds.mjs'
            image = indent((source / 'stacks/late-cutover-pds.yaml').read_text().rstrip(), '    ')
            command_marker = '    command: node tests/support/start-pds.mjs'
            volumes_marker = '    volumes:\n'
            if service.count(command_marker) != 1 or service.count(volumes_marker) != 1:
                raise SystemExit('Unexpected staged PDS template')
            service = service.replace(command_marker, image)
            service = service.replace(volumes_marker, f'    volumes:\n      - {launcher}:/app/services/pds/start-pds.mjs:ro,z\n')
            text = text[:start] + service + text[end:]
        if app == 'hypercerts-entryway' and os.environ.get('ENTRYWAY_TRANSFER_HISTORY') == '1':
            if suffix == '.yaml':
                start = text.index('\n  pds2:\n') + 1
                end = text.index('\n  test:\n', start) + 1
                service = text[start:end].replace('pds2', 'pds-history-c').replace('cluster2-data', 'cluster-c-data')
                text = text[:end] + service + text[end:]
                text = text.replace('      - pds2-config:/pds2-config\n', '      - pds2-config:/pds2-config\n      - pds-history-c-config:/pds-history-c-config\n')
                text = text.replace('      ENTRYWAY_LATE_CUTOVER: ${ENTRYWAY_LATE_CUTOVER:-0}\n', '      ENTRYWAY_LATE_CUTOVER: ${ENTRYWAY_LATE_CUTOVER:-0}\n      ENTRYWAY_TRANSFER_HISTORY: "1"\n')
                text = text.replace('  pds2-config: {}\n', '  pds2-config: {}\n  pds-history-c-config: {}\n  cluster-c-data: {}\n')
            else:
                definition = json.loads(text)
                configure = next(service for service in definition['services'] if service['service'] == 'configure')
                configure['environment'].append({'name': 'PDS_HISTORY_C_URL', 'source': {'kind': 'route-url', 'route': 'cluster-c'}})
                definition['services'].append({'service': 'pds-history-c', 'environment': []})
                definition['routes'].append({'id': 'cluster-c', 'service': 'pds-history-c', 'host': 'cluster-c', 'port': 3000})
                text = json.dumps(definition, indent=2) + '\n'
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
                # Chain gateway -> entryway-ingress (CORS) -> profile-ingress -> nodes.
                old_ingress = '      - ../../tests/support/entryway-ingress.Caddyfile:/etc/caddy/Caddyfile:ro,z\n    networks: [atmosinabox]\n    depends_on:\n      entryway: { condition: service_healthy }\n'
                if text.count(old_ingress) != 1:
                    raise SystemExit('Unexpected entryway-ingress template')
                text = text.replace(old_ingress, '      - ../../tests/support/entryway-ingress.Caddyfile:/etc/caddy/Caddyfile:ro,z\n    environment:\n      ENTRYWAY_UPSTREAM: profile-ingress:3000\n    networks: [atmosinabox]\n    depends_on:\n      profile-ingress: { condition: service_healthy }\n')
            else:
                definition = json.loads(text)
                definition['services'].append({'service': 'profile-ingress', 'environment': []})
                if profile_nodes == '2':
                    definition['services'].append({'service': 'entryway-replica', 'environment': []})
                text = json.dumps(definition, indent=2) + '\n'
        # Compose paths resolve relative to the generated file in the clone.
        text = text.replace('context: ../..', 'context: ' + json.dumps(str(root)))
        text = text.replace('../../tests/support/entryway-ingress.Caddyfile', str(root / 'tests/support/entryway-ingress.Caddyfile'))
        text = text.replace('../artifacts:/app/artifacts:z', os.environ.get('ACCEPTANCE_REPORT_DIR', str(root / 'tests/artifacts')) + ':/app/artifacts:z')
        target = sandbox / 'stacks' / (app + suffix)
        if target.exists() and target.read_text() != text and (sandbox / 'state/manifest.json').exists():
            raise SystemExit(f'Template drift in existing state: {app}; review and use a fresh runtime, not silent overwrite')
        target.write_text(text)
registry_path.write_text(json.dumps(registry, indent=2)+'\n')
shutil.copytree(source / 'examples/entryway-oauth-web-app', sandbox / 'examples/entryway-oauth-web-app', dirs_exist_ok=True)
