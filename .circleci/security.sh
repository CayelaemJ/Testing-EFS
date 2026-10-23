#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p security-reports
export PATH="$HOME/.local/bin:$HOME/go/bin:$PATH"
echo "Installing security scanners"
python -m pip install --disable-pip-version-check "semgrep>=1.100,<2" "schemathesis>=4,<5"
mkdir -p "$HOME/.local/bin"
curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b "$HOME/.local/bin"
curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_linux_x64.tar.gz | tar -xz -C "$HOME/.local/bin" gitleaks
echo "Running independent security scans"
failed=0
run_check() {
  local name="$1"; shift
  echo "=== $name ==="
  if "$@"; then
    printf '%s: PASS\n' "$name" >> security-reports/summary.txt
  else
    rc=$?
    printf '%s: FAIL (exit %s)\n' "$name" "$rc" >> security-reports/summary.txt
    failed=1
  fi
}
run_check semgrep semgrep scan --config p/security-audit --config p/owasp-top-ten --error --exclude node_modules --exclude dist --exclude build --json --output security-reports/semgrep.json .
run_check gitleaks gitleaks git --redact --exit-code 1 --report-format json --report-path security-reports/gitleaks.json
run_check trivy trivy fs --scanners vuln,misconfig,secret --severity HIGH,CRITICAL --exit-code 1 --format json --output security-reports/trivy.json .
# Network testing is opt-in and must target an owned isolated staging system.
if [ "${SECURITY_ACTIVE_SCAN_APPROVED:-}" = "YES_STAGING_ONLY" ] && [ -n "${SECURITY_STAGING_URL:-}" ]; then
  case "$SECURITY_STAGING_URL" in
    https://*staging*|https://*test*|https://*preview*) ;;
    *) echo "Refusing unapproved target"; exit 2;;
  esac
  run_check nuclei_install go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@v3.4.10
  if command -v nuclei >/dev/null 2>&1; then
    run_check nuclei nuclei -u "$SECURITY_STAGING_URL" -severity medium,high,critical -rate-limit 2 -concurrency 2 -jsonl -o security-reports/nuclei.jsonl
  fi
  if [ -n "${SECURITY_OPENAPI_URL:-}" ]; then
    run_check schemathesis schemathesis run "$SECURITY_OPENAPI_URL" --max-examples 5 --rate-limit 2/s
  fi
else
  printf 'Active staging scans: SKIPPED (approval/URL absent)\n' >> security-reports/summary.txt
fi
cat security-reports/summary.txt
exit "$failed"
