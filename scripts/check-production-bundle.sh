#!/usr/bin/env bash
# Builds the production bundle and verifies that no demo code leaked into it.
# Checks for absence of demo fixture strings AND the error message unique to
# demoApiAdapter.ts.  Also verifies that authentication code is present.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$SCRIPT_DIR/../dashboard"
DIST_DIR="$DASHBOARD_DIR/dist"

cd "$DASHBOARD_DIR"

echo "==> Building production bundle..."
npm run build

echo "==> Scanning for demo fixture strings..."

FAIL=0

check_absent() {
  local pattern="$1"
  local label="$2"
  if grep -rql "$pattern" "$DIST_DIR/assets/"*.js 2>/dev/null; then
    echo "FAIL: Demo string found in production bundle: $label"
    FAIL=1
  else
    echo "  ok: '$label' not present"
  fi
}

check_present() {
  local pattern="$1"
  local label="$2"
  if grep -rql "$pattern" "$DIST_DIR/assets/"*.js 2>/dev/null; then
    echo "  ok: '$label' present (auth code confirmed)"
  else
    echo "FAIL: Expected production auth string missing: $label"
    FAIL=1
  fi
}

# Demo fixture IDs — unique to synthetic demo data
check_absent 'demo-session-baseline'  'demo-session-baseline (fixture ID)'
check_absent 'demo-session-candidate' 'demo-session-candidate (fixture ID)'
check_absent 'demo-comparison-01'     'demo-comparison-01 (fixture ID)'

# Error message unique to demoApiAdapter.ts
check_absent 'Demo mode: unhandled'   'Demo mode: unhandled (adapter error string)'

# Auth endpoint — confirms authentication code survived tree-shaking
check_present '/dashboard/login'      '/dashboard/login (auth endpoint)'

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "==> FAILED: Production bundle contains demo code or is missing auth code."
  exit 1
fi

echo ""
echo "==> PASSED: Production bundle is clean."
