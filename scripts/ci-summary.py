"""Contributors: publish test identities and fixed diagnostics, never runtime payloads."""
from pathlib import Path
import re
import sys

# Only repository-declared literal titles may be published. Never echo arbitrary
# reporter lines: assertion values and browser console output can contain secrets.
root = Path(__file__).resolve().parents[1]
titles = set()
for directory in (root / "tests", root / "src"):
    for path in directory.rglob("*.mjs"):
        if any(part in {".runtime", "artifacts", "node_modules"} for part in path.parts):
            continue
        titles.update(match[1] for match in re.findall(r'\b(?:test|it|describe)\(\s*(["\'])([^\n]*?)\1', path.read_text()))
summary = re.compile(r"^(?:(?:#|ℹ) (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [0-9.]+|[0-9]+ (?:passed|failed|skipped)(?: \([0-9.ms]+\))?)$")
diagnostics = {
    "unknown flag:": ("CLI_USAGE_ERROR", "Command rejected an unsupported flag; inspect the private phase log"),
    "Cannot connect to the Docker daemon": ("DOCKER_UNAVAILABLE", "Docker daemon connection failed; check the selected context"),
    "Error response from daemon": ("DOCKER_OPERATION_FAILED", "Docker rejected the operation; inspect the private phase log"),
    "no such service": ("DOCKER_SERVICE_MISSING", "Compose service is missing from the generated configuration"),
    "is not running": ("DOCKER_SERVICE_STOPPED", "Required container is not running"),
    "permission denied": ("PERMISSION_DENIED", "Operation lacks permission; inspect the private phase log"),
    "ERR_ASSERTION": ("ASSERTION_FAILED", "Test assertion failed; values retained only in the private phase log"),
    "TimeoutError": ("TEST_TIMEOUT", "Test exceeded its deadline"),
}
for line in sys.stdin:
    text = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
    if summary.fullmatch(text):
        print(text, flush=True)
    elif re.match(r"^(?:[✔✖✓✘×]|(?:not )?ok \d+|\d+\))", text):
        for title in sorted(titles, key=len, reverse=True):
            if title in text:
                status = "failed" if re.match(r"^(?:[✖✘×]|not ok|\d+\))", text) else "passed"
                print(f"test={title} status={status}", flush=True)
                break
    else:
        for marker, (code, context) in diagnostics.items():
            if marker in text:
                print(f"code={code} context={context}", flush=True)
                break
