"""CI maintainers: record owned sandboxes before provisioning and clean only those identities."""
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    action, manifest_name = sys.argv[1:3]
    manifest = Path(manifest_name).resolve()
    root = Path(__file__).resolve().parents[1]
    runtime = root / "tests/.runtime"
    context = os.environ.get("ENTRYWAY_DOCKER_CONTEXT", "rootless")
    if context not in ("rootless", "default"):
        raise ValueError("Unsupported Docker context")
    if action == "init":
        manifest.parent.mkdir(parents=True, exist_ok=True)
        with manifest.open("x") as stream:
            json.dump({"root": str(root), "context": context, "projects": []}, stream)
        return
    record = json.loads(manifest.read_text())
    if record["context"] != context:
        raise ValueError("CI Docker context identity mismatch")
    if record["root"] != str(root):
        raise ValueError("CI checkout identity mismatch")
    if action == "register":
        checkout, project = sys.argv[3:5]
        candidate = {"checkout": str(Path(checkout).resolve()), "project": project}
        if candidate not in record["projects"]:
            record["projects"].append(candidate)
    elif action != "cleanup":
        raise ValueError("Unknown ownership operation")
    # Validate the entire set before allowing any destructive operation.
    for item in record["projects"]:
        checkout = Path(item["checkout"])
        project = item["project"]
        if not checkout.is_relative_to(runtime) or checkout == runtime:
            raise ValueError("CI checkout outside owned runtime directory")
        if not project.startswith("hypercerts-entryway-") or not all(
            char.islower() or char.isdigit() or char in "-_" for char in project
        ):
            raise ValueError("Invalid CI project identity")
        state = checkout / "state/manifest.json"
        if state.exists() and json.loads(state.read_text())["project"] != project:
            raise ValueError("Sandbox project identity mismatch")
    if action == "register":
        temporary = manifest.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, indent=2) + "\n")
        os.replace(temporary, manifest)
        return
    subprocess.run(["bash", "-c", 'source "$1"', "docker-preflight",
                    str(root / "tests/support/rootless-docker.sh")], check=True)
    failed = False
    for item in reversed(record["projects"]):
        compose = Path(item["checkout"]) / "compose.yaml"
        if compose.exists():
            result = subprocess.run([
                "docker", "--context", context, "compose", "--project-name",
                item["project"], "-f", str(compose), "down", "--volumes", "--remove-orphans",
            ], check=False, env={**os.environ, "SOURCE_CHECKOUT": str(root),
                                  "SANDBOX_PROJECT": item["project"],
                                  "COMPOSE_PROFILES": "*",
                                  "ACCEPTANCE_REPORT_DIR": str(manifest.parent / "reports")})
            failed |= result.returncode != 0
        for resource, arguments in [("container", ["--all"]), ("network", []), ("volume", [])]:
            result = subprocess.run([
                "docker", "--context", context, resource, "ls", *arguments,
                "--quiet", "--filter", f"label=com.docker.compose.project={item['project']}",
            ], check=False, capture_output=True, text=True)
            if result.returncode != 0 or result.stdout.strip():
                print(f"Cleanup could not verify absence of {resource} resources for {item['project']}",
                      file=sys.stderr)
                failed = True
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
