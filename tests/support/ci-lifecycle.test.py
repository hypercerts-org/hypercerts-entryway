"""Contributors: exercise the CI lifecycle in a container without a Docker socket."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for directory in ["scripts", "tests/support", "tests/.runtime", "bin"]:
            (self.root / directory).mkdir(parents=True)
        source = Path(__file__).resolve().parents[2]
        for name in ["ci.sh", "ci-ownership.py"]:
            shutil.copy(source / "scripts" / name, self.root / "scripts" / name)
        (self.root / "tests/support/rootless-docker.sh").write_text("true\n")
        local = self.root / "tests/local.sh"
        local.write_text('''#!/bin/bash
set -eu
mkdir -p "$SANDBOX_CHECKOUT/state"
printf '{"project":"%s"}' "$SANDBOX_PROJECT" > "$SANDBOX_CHECKOUT/state/manifest.json"
printf 'services: {}' > "$SANDBOX_CHECKOUT/compose.yaml"
case "${FIXTURE_RESULT:-success}" in
  failure) exit 17 ;;
  partial) rm "$SANDBOX_CHECKOUT/state/manifest.json"; exit 18 ;;
  mismatch) echo '{"project":"someone-else"}' > "$SANDBOX_CHECKOUT/state/manifest.json" ;;
  term) kill -TERM "$PPID" ;;
esac
''')
        local.chmod(0o755)
        docker = self.root / "bin/docker"
        docker.write_text('''#!/bin/bash
printf '%s | profiles=%s\\n' "$*" "${COMPOSE_PROFILES:-}" >> "$CALLS"
if [[ "$*" == *' compose '* ]]; then
  exit "${CLEANUP_EXIT:-0}"
fi
if [[ "${LEAK_RESOURCE:-}" != '' && "$*" == *" $LEAK_RESOURCE ls "* ]]; then
  echo leaked-resource
fi
exit "${INSPECT_EXIT:-0}"
''')
        docker.chmod(0o755)
        self.manifest = self.root / "reports/ownership.json"
        self.calls = self.root / "calls"
        self.env = {**os.environ, "PATH": f"{self.root / 'bin'}:{os.environ['PATH']}",
                    "CI_OWNERSHIP_MANIFEST": str(self.manifest), "CALLS": str(self.calls)}

    def run_mode(self, mode="integration", **environment):
        return subprocess.run(["bash", str(self.root / "scripts/ci.sh"), mode],
                              env={**self.env, **environment}, capture_output=True, timeout=15)

    def test_success_and_repeated_cleanup(self):
        self.assertEqual(self.run_mode(COMPOSE_PROFILES="unrelated").returncode, 0)
        self.assertEqual(self.run_mode("cleanup", COMPOSE_PROFILES="unrelated").returncode, 0)
        calls = self.calls.read_text().splitlines()
        self.assertEqual(len(calls), 8)
        self.assertEqual(calls[:4], calls[4:])
        self.assertIn("down --volumes --remove-orphans | profiles=*", calls[0])
        project = json.loads(self.manifest.read_text())["projects"][0]
        self.assertIn(f"--project-name {project['project']} -f {project['checkout']}/compose.yaml", calls[0])
        for call in calls[1:4]:
            self.assertIn(f"label=com.docker.compose.project={project['project']}", call)

    def test_failure_preserved_even_when_cleanup_fails(self):
        self.assertEqual(self.run_mode(FIXTURE_RESULT="failure", CLEANUP_EXIT="7").returncode, 17)
        self.assertTrue(self.calls.exists())

    def test_cleanup_failure_fails_successful_run(self):
        self.assertEqual(self.run_mode(CLEANUP_EXIT="7").returncode, 1)

    def test_leaked_resources_fail_cleanup(self):
        self.assertEqual(self.run_mode().returncode, 0)
        for resource in ("container", "network", "volume"):
            with self.subTest(resource=resource):
                self.assertNotEqual(self.run_mode("cleanup", LEAK_RESOURCE=resource).returncode, 0)

    def test_inspection_failure_fails_cleanup(self):
        self.assertEqual(self.run_mode(INSPECT_EXIT="9").returncode, 1)

    def test_partial_provision(self):
        self.assertEqual(self.run_mode(FIXTURE_RESULT="partial").returncode, 18)
        self.assertTrue(self.calls.exists())

    def test_term_cleans(self):
        self.assertEqual(self.run_mode(FIXTURE_RESULT="term").returncode, 143)
        self.assertTrue(self.calls.exists())

    def test_mismatch_refuses_cleanup(self):
        self.assertNotEqual(self.run_mode(FIXTURE_RESULT="mismatch").returncode, 0)
        self.assertFalse(self.calls.exists())

    def test_unknown_mode_has_no_side_effects(self):
        self.assertEqual(self.run_mode("unknown").returncode, 2)
        self.assertFalse(self.manifest.exists())

    def test_child_registration_before_provision(self):
        self.assertEqual(self.run_mode().returncode, 0)
        child = self.root / "tests/.runtime/child"
        result = subprocess.run(["python3", str(self.root / "scripts/ci-ownership.py"),
                                 "register", str(self.manifest), str(child),
                                 "hypercerts-entryway-child"], capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(json.loads(self.manifest.read_text())["projects"]), 2)
        self.assertEqual(self.run_mode("cleanup").returncode, 0)


if __name__ == "__main__":
    unittest.main()
