"""Contributors: verify owned cleanup and Docker selection without a daemon."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for directory in ["scripts", "tests/support", "tests/.runtime/parent", "bin"]:
            (self.root / directory).mkdir(parents=True)
        source = Path(__file__).resolve().parents[2]
        shutil.copy(source / "scripts/ci-ownership.py", self.root / "scripts/ci-ownership.py")
        shutil.copy(source / "tests/support/rootless-docker.sh", self.root / "tests/support/rootless-docker.sh")
        docker = self.root / "bin/docker"
        docker.write_text('''#!/bin/bash
printf '%s | profiles=%s\\n' "$*" "${COMPOSE_PROFILES:-}" >> "$CALLS"
case "$*" in
  *' context inspect '*) echo "${ENDPOINT:-unix:///run/user/1000/docker.sock}" ;;
  *' info '*) echo "${SECURITY:-[\"name=rootless\"]}" ;;
  *' compose '*) exit "${CLEANUP_EXIT:-0}" ;;
  *) if [[ -n "${LEAK_RESOURCE:-}" && "$*" == *" $LEAK_RESOURCE ls "* ]]; then echo leaked; fi; exit "${INSPECT_EXIT:-0}" ;;
esac
''')
        docker.chmod(0o755)
        self.manifest = self.root / "reports/ownership.json"
        self.calls = self.root / "calls"
        self.env = {**os.environ, "PATH": f"{self.root / 'bin'}:{os.environ['PATH']}",
                    "ENTRYWAY_DOCKER_CONTEXT": "rootless", "CALLS": str(self.calls)}
        self.checkout = self.root / "tests/.runtime/parent"
        self.assertEqual(self.ownership("init").returncode, 0)
        self.assertEqual(self.ownership("register", str(self.checkout), "hypercerts-entryway-parent").returncode, 0)
        (self.checkout / "compose.yaml").write_text("services: {}")

    def ownership(self, action, *arguments, **environment):
        return subprocess.run(["python3", str(self.root / "scripts/ci-ownership.py"), action,
                               str(self.manifest), *arguments], env={**self.env, **environment},
                              capture_output=True, text=True, timeout=15)

    def guard(self, **environment):
        return subprocess.run(["bash", "-c", 'source "$1" && test -z "${DOCKER_HOST:-}"',
                               "guard", str(self.root / "tests/support/rootless-docker.sh")],
                              env={**self.env, **environment}, capture_output=True, timeout=15)

    def test_repeated_scoped_cleanup(self):
        for _ in range(2):
            self.assertEqual(self.ownership("cleanup", COMPOSE_PROFILES="unrelated").returncode, 0)
        calls = self.calls.read_text()
        self.assertEqual(calls.count("down --volumes --remove-orphans | profiles=*"), 2)
        self.assertIn("label=com.docker.compose.project=hypercerts-entryway-parent", calls)
        self.assertNotIn("prune", calls)

    def test_cleanup_and_inspection_failures(self):
        for environment in [{"CLEANUP_EXIT": "7"}, {"INSPECT_EXIT": "9"},
                            *({"LEAK_RESOURCE": resource} for resource in ("container", "network", "volume"))]:
            self.assertNotEqual(self.ownership("cleanup", **environment).returncode, 0)

    def test_partial_child_registered_before_provision(self):
        self.assertEqual(self.ownership("register", str(self.root / "tests/.runtime/child"),
                                        "hypercerts-entryway-child").returncode, 0)
        self.assertEqual(self.ownership("cleanup").returncode, 0)
        self.assertIn("label=com.docker.compose.project=hypercerts-entryway-child", self.calls.read_text())

    def test_foreign_project_refused_before_docker(self):
        (self.checkout / "state").mkdir()
        (self.checkout / "state/manifest.json").write_text('{"project":"someone-else"}')
        self.assertNotEqual(self.ownership("cleanup").returncode, 0)
        self.assertFalse(self.calls.exists())

    def test_outside_checkout_refused(self):
        self.assertNotEqual(self.ownership("register", str(self.root / "foreign"),
                                           "hypercerts-entryway-child").returncode, 0)

    def test_invalid_records_fail_before_any_docker(self):
        original = json.loads(self.manifest.read_text())
        outside = self.root / "foreign"
        outside.mkdir()
        for checkout in [str(self.checkout / "../../../../foreign"), str(self.root / "tests/.runtime/link")]:
            link = self.root / "tests/.runtime/link"
            if not link.exists():
                link.symlink_to(outside, target_is_directory=True)
            record = {**original, "projects": [*original["projects"], {"checkout": checkout, "project": "hypercerts-entryway-child"}]}
            self.manifest.write_text(json.dumps(record))
            self.assertNotEqual(self.ownership("cleanup").returncode, 0)
            self.assertFalse(self.calls.exists())
        self.manifest.write_text(json.dumps({**original, "projects": [*original["projects"], {}]}))
        self.assertNotEqual(self.ownership("cleanup").returncode, 0)
        self.assertFalse(self.calls.exists())

    def test_sandbox_file_symlinks_refused(self):
        outside = self.root / "outside"
        outside.write_text('{"project":"hypercerts-entryway-parent"}')
        for name in ["state/manifest.json", "compose.yaml"]:
            path = self.checkout / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.unlink(missing_ok=True)
            path.symlink_to(outside)
            self.assertNotEqual(self.ownership("cleanup").returncode, 0)
            self.assertFalse(self.calls.exists())
            path.unlink()

    def test_predictable_temporary_symlink_not_used(self):
        target = self.root / "target"
        target.write_text("untouched")
        self.manifest.with_suffix(".tmp").symlink_to(target)
        self.assertEqual(self.ownership("register", str(self.root / "tests/.runtime/child"),
                                        "hypercerts-entryway-child").returncode, 0)
        self.assertEqual(target.read_text(), "untouched")

    def test_context_mismatch_refused(self):
        self.assertNotEqual(self.ownership("cleanup", ENTRYWAY_DOCKER_CONTEXT="default").returncode, 0)
        self.assertFalse(self.calls.exists())

    def test_rootless_guard_ignores_docker_host(self):
        self.assertEqual(self.guard(DOCKER_HOST="tcp://foreign:2375").returncode, 0)
        self.assertNotEqual(self.guard(ENDPOINT="unix:///var/run/docker.sock").returncode, 0)
        self.assertNotEqual(self.guard(SECURITY='["name=seccomp"]').returncode, 0)

    def test_explicit_default_guard(self):
        self.assertEqual(self.guard(ENTRYWAY_DOCKER_CONTEXT="default",
                                    ENDPOINT="unix:///var/run/docker.sock", SECURITY='["name=seccomp"]').returncode, 0)
        self.assertNotEqual(self.guard(ENTRYWAY_DOCKER_CONTEXT="default").returncode, 0)
        self.assertNotEqual(self.guard(ENTRYWAY_DOCKER_CONTEXT="foreign").returncode, 0)

    def test_incoming_helpers_have_explicit_native_coverage(self):
        source = Path(__file__).resolve().parents[2]
        package = json.loads((source / "package.json").read_text())
        helpers = ["tests/support/helpers/stock-plc-mailpit.test.mjs",
                   "tests/support/helpers/incoming-public-io.test.mjs",
                   "tests/atmosphere/project-incoming-access.test.mjs"]
        self.assertEqual(package["scripts"]["test:incoming-helpers"].split(),
                         ["node", "--test", *helpers])
        checks = (source / ".github/workflows/ci.yml").read_text().split("  integration:", 1)[0]
        self.assertEqual(checks.count("run: npm run test:incoming-helpers\n"), 1)
        discovery = subprocess.run(["node", "--input-type=module", "-e",
            "import {discoverContracts} from './tests/support/discover-contracts.mjs';"
            "console.log(JSON.stringify(discoverContracts(undefined,{unit:true})))"],
            cwd=source, capture_output=True, text=True, check=True)
        files = json.loads(discovery.stdout)
        self.assertEqual(len(files), len(set(files)))
        for helper in helpers:
            self.assertNotIn(helper, files)
        self.assertNotIn("tests/contracts/incoming-public-mechanisms.test.mjs", files)

    def test_live_controller_shell_syntax(self):
        source = Path(__file__).resolve().parents[2]
        for script in [source / "tests/local.sh", *sorted((source / "tests/support").glob("*.sh"))]:
            with self.subTest(script=script.name):
                result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_summary_does_not_publish_payloads(self):
        source = Path(__file__).resolve().parents[2]
        result = subprocess.run(["python3", str(source / "scripts/ci-summary.py")],
                                input='OTP 123456\naccess_token=private\nℹ pass 12\n  3 passed (1.2s)\nassertion payload\n',
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, 'ℹ pass 12\n3 passed (1.2s)\n')

    def test_summary_rejects_non_ascii_digits_payload_and_bad_durations(self):
        source = Path(__file__).resolve().parents[2]
        result = subprocess.run(["python3", str(source / "scripts/ci-summary.py")],
                                input='# pass ١٢\n3 passed (١s)\n3 passed (1s) secret\n3 passed (1..2s)\nℹ duration_ms 1..2\n# tests 12\n3 passed (12ms)\n',
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, '# tests 12\n3 passed (12ms)\n')

    def test_named_failure_and_docker_context_without_payloads(self):
        source = Path(__file__).resolve().parents[2]
        title = "email OTP onboarding, invalid code, replay, real PDS1 write and OAuth refresh"
        result = subprocess.run(["python3", str(source / "scripts/ci-summary.py")],
                                input=f'✖ {title} (12ms)\nError response from daemon: secret-token\nERR_ASSERTION: OTP 123456\n',
                                capture_output=True, text=True, check=True)
        self.assertIn(f"test={title} status=failed", result.stdout)
        self.assertIn("code=DOCKER_OPERATION_FAILED", result.stdout)
        self.assertIn("code=ASSERTION_FAILED", result.stdout)
        self.assertNotIn("secret-token", result.stdout)
        self.assertNotIn("123456", result.stdout)

    def test_restart_commands_use_explicit_readiness(self):
        source = Path(__file__).resolve().parents[2]
        text = (source / "tests/support/run-resilience-profile.sh").read_text()
        for restart, readiness, browser in [
            ("graceful-rejoin", "readiness-rejoin", "rejoin"),
            ("kill-rejoin", "readiness-kill-rejoin", "kill-rejoin-browser"),
        ]:
            lines = text.splitlines()
            start = next(index for index, line in enumerate(lines) if line.startswith(f"run {restart} "))
            self.assertTrue(lines[start].endswith(" start entryway"))
            self.assertIn("timeout 30s docker ", lines[start])
            self.assertEqual(lines[start + 1], f"run {readiness} probe ready {readiness}.json")
            self.assertTrue(lines[start + 2].startswith(f"run {browser} browser "))
        self.assertNotIn("start --wait", text)

    def test_summary_prunes_excluded_directories(self):
        source = Path(__file__).resolve().parents[2]
        shutil.copy(source / "scripts/ci-summary.py", self.root / "scripts/ci-summary.py")
        for directory in ["tests/visible", "tests/.runtime", "src/artifacts", "src/node_modules"]:
            path = self.root / directory
            path.mkdir(parents=True, exist_ok=True)
            (path / "example.mjs").write_text(f'test("{path.name} title", () => {{}});')
        wrapper = '''import os, runpy, sys
original = os.scandir
def scan(path):
    print(f"scanned={path}", file=sys.stderr)
    return original(path)
os.scandir = scan
runpy.run_path(sys.argv[1], run_name="__main__")
'''
        result = subprocess.run(["python3", "-c", wrapper, str(self.root / "scripts/ci-summary.py")],
                                input="✔ visible title\n✔ .runtime title\n✔ artifacts title\n✔ node_modules title\n",
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, "test=visible title status=passed\n")
        for directory in ["tests/.runtime", "src/artifacts", "src/node_modules"]:
            self.assertNotIn(f"scanned={self.root / directory}", result.stderr)

    def test_repeated_phase_logs_keep_mock_command_output(self):
        source = Path(__file__).resolve().parents[2]
        profile = (source / "tests/support/run-postgresql-profile.sh").read_text()
        probe = profile.split("probe() {", 1)[1].split("\n}", 1)[0]
        commands = [line for line in profile.splitlines()
                    if line.startswith("compose ") and ('/restart.log' in line or '/restore.log' in line)]
        crash = (source / "tests/support/run-process-crash.sh").read_text()
        commands += [line.strip() for line in crash.splitlines() if 'tee ' in line and 'pds-drain.log' in line]
        shutil.copy(source / "scripts/ci-summary.py", self.root / "scripts/ci-summary.py")
        script = '''set -euo pipefail
root="$1"; ACCEPTANCE_REPORT_DIR="$root"; artifacts="$root"; mode=example
compose() { printf 'mock %s\\n' "$*"; }
probe() {\n''' + probe + '\n}\n' + '\n'.join(commands[:2]) + '\nprobe restart\n' + '\n'.join(commands[2:]) + '\nprobe restore\n'
        result = subprocess.run(["bash", "-c", script, "phase-test", str(self.root)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        restart = (self.root / "restart.log").read_text()
        restore = (self.root / "restore.log").read_text()
        drain = (self.root / "crash-example-pds-drain.log").read_text()
        for marker in ["restart entryway", "up -d --wait entryway", "postgresql-profile.mjs restart"]:
            self.assertIn(marker, restart)
        for marker in ["stop entryway", "pg_dump", "force-recreate", "postgresql-profile.mjs restore"]:
            self.assertIn(marker, restore)
        for marker in ["stop --timeout 10 pds1", "start pds1"]:
            self.assertIn(marker, drain)

    def test_unknown_flag_diagnostic_redacts_payload(self):
        source = Path(__file__).resolve().parents[2]
        result = subprocess.run(["python3", str(source / "scripts/ci-summary.py")],
                                input="unknown flag: --secret-token OTP 123456\n",
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, "code=CLI_USAGE_ERROR context=Command rejected an unsupported flag; inspect the private phase log\n")
        self.assertNotIn("secret-token", result.stdout)
        self.assertNotIn("123456", result.stdout)

    def test_pretest_docker_failure_keeps_phase_and_exit(self):
        source = Path(__file__).resolve().parents[2]
        shutil.copy(source / "tests/local.sh", self.root / "tests/local.sh")
        result = subprocess.run(["bash", str(self.root / "tests/local.sh"), "browser"],
                                env={**self.env, "SANDBOX_CHECKOUT": str(self.checkout),
                                     "ACCEPTANCE_REPORT_DIR": str(self.root / "reports"),
                                     "ENDPOINT": "unix:///wrong.sock"},
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("phase=browser status=started", result.stdout)
        self.assertIn("phase=browser status=finished exit=1", result.stdout)

    def test_nested_controller_is_not_filtered_twice(self):
        source = Path(__file__).resolve().parents[2]
        text = (source / "tests/support/run-resilience-profile.sh").read_text()
        self.assertIn('|| "$label" == exercise', text)
        self.assertIn('profile=%s phase=%s status=finished exit=%s', text)
        run_function = text.split('run() {', 1)[1].split('\ncleanup()', 1)[0]
        result = subprocess.run(['bash', '-c',
                                 'set -o pipefail; profile=sqlite-single-node; '
                                 'ACCEPTANCE_REPORT_DIR="$1"; PROFILE_EXERCISE_TRIGGER_MS=$(date +%s%3N); '
                                 'run() {' + run_function + '\n'
                                 'run exercise bash -c "echo phase=journey status=started; exit 7"',
                                 'nested-test', str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 7)
        self.assertIn('phase=journey status=started', result.stdout)
        self.assertIn('phase=exercise status=finished exit=7', result.stdout)


if __name__ == "__main__":
    unittest.main()
