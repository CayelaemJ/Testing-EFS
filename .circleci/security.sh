#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p security-reports
export PATH="$HOME/.local/bin:$HOME/go/bin:$PATH"
echo "Installing security scanners"
python -m pip install --disable-pip-version-check "semgrep>=1.100,<2" "schemathesis>=4,<5"
mkdir -p "$HOME/.local/bin"
curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b "$HOME/.local/bin"
curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_linux_x64.tar.gz | tar -xz -C "$HOME/.local/bin" gitleaks
echo "Scanning source code and secret exposures"
semgrep scan --config p/security-audit --config p/owasp-top-ten --error --exclude node_modules --exclude dist --exclude build --json --output security-reports/semgrep.json . 
gitleaks git --redact --exit-code 1 --report-format json --report-path security-reports/gitleaks.json
trivy fs --scanners vuln,misconfig,secret --severity HIGH,CRITICAL --exit-code 1 --format json --output security-reports/trivy.json .
echo "Static scans completed"
# Active testing requires a dedicated staging URL and an explicit approval flag.
if [ "${SECURITY_ACTIVE_SCAN_APPROVED:-}" = "YES_STAGING_ONLY" ] && [ -n "${SECURITY_STAGING_URL:-}" ]; then
  case "$SECURITY_STAGING_URL" in
    https://*staging*|https://*test*|https://*preview*) ;;
    *) echo "Only a clearly named HTTPS staging/test/preview target is accepted"; exit 2;;
  esac
  go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@v3.4.10
  nuclei -u "$SECURITY_STAGING_URL" -severity medium,high,critical -rate-limit 2 -concurrency 2 -jsonl -o security-reports/nuclei.jsonl
  if [ -n "${SECURITY_OPENAPI_URL:-}" ]; then
    schemathesis run "$SECURITY_OPENAPI_URL" --max-examples 5 --rate-limit 2/s
  fi
else
  echo "Nuclei and Schemathesis live API scans skipped: staging approval not set."
fi
