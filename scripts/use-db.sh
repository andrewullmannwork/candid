#!/bin/bash
# OPS.9 — switch local .env.local between DEV and PROD Supabase.
#   Usage: ./scripts/use-db.sh dev|prod
# Named copies .env.local.dev / .env.local.prod hold each full config (both gitignored).
# DEV is the safe default; only switch to prod for a deliberate one-off admin task.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  dev)
    cp .env.local.dev .env.local
    echo "→ .env.local = DEV  ($(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2))"
    ;;
  prod)
    cp .env.local.prod .env.local
    echo "→ .env.local = PROD ($(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2))"
    echo "⚠️  Pointed at PRODUCTION. Do NOT run resets or destructive tests."
    ;;
  *)
    echo "usage: ./scripts/use-db.sh dev|prod"; exit 1 ;;
esac
echo "Restart your dev server (npm run dev) to pick up the change."
