#!/usr/bin/env bash
# Focused local gate; hosted exact-commit CI is still required before rollout.
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsc -p scripts/tsconfig.deployment-recovery.json --noEmit
npx vitest run scripts/cloudflare-deployment-client.test.ts scripts/deployment-write-receipts.test.ts scripts/deployment-audit-reconciliation.test.ts scripts/deployment-recovery.test.ts scripts/deployment-recovery-lease.test.ts scripts/release-activation-cli.test.ts scripts/release-activation-evidence.test.ts scripts/release-frontend-observation.test.ts scripts/release-watch.test.ts
python3 scripts/check-format.py
git diff --check
