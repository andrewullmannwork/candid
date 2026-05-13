#!/usr/bin/env bash
#
# release-to-prod.sh — promote current main to the production branch.
#
# Session 81 release workflow: Vercel's production branch is `production`, not
# `main`. Merges to `main` only create preview deploys; to ship to PROD you
# fast-forward `production` to the commit you want live. This script wraps
# that with safety checks + a diff summary + a confirmation prompt.
#
# Usage:
#   ./scripts/release-to-prod.sh
#
# What it does:
#   1. Verifies you're in a clean working tree
#   2. Fetches origin (refreshes main + production refs)
#   3. Shows the commits that will be promoted (origin/production..origin/main)
#   4. Asks for `yes` confirmation
#   5. Fast-forwards origin/production to origin/main via `git push origin origin/main:production`
#   6. Reminds you Vercel will deploy from the push within ~1-2 min
#
# Exits non-zero on any failure or user-decline.

set -euo pipefail

# Move to repo root regardless of where the script is invoked from.
cd "$(dirname "$0")/.."

echo "🚀 release-to-prod — promote main → production"
echo ""

# Working-tree safety. We don't actually need a clean tree to push (the push
# uses remote refs), but a dirty tree usually means the user has uncommitted
# work they meant to ship. Surface that before doing anything.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "⚠ Working tree has uncommitted changes:"
  git status --short
  echo ""
  read -r -p "Continue anyway? (yes/no) " continue_dirty
  if [[ "$continue_dirty" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "Fetching origin…"
git fetch origin main production 2>&1 | sed 's/^/  /'
echo ""

# Compute commits ahead of production. If none, nothing to ship.
commits_ahead=$(git rev-list --count origin/production..origin/main || echo "0")
if [[ "$commits_ahead" == "0" ]]; then
  echo "✓ origin/production is already at origin/main. Nothing to promote."
  exit 0
fi

echo "Commits that will be promoted to PROD ($commits_ahead total):"
git log --oneline origin/production..origin/main | sed 's/^/  /'
echo ""

echo "Files changed:"
git diff --stat origin/production..origin/main | sed 's/^/  /'
echo ""

read -r -p "Promote main → production and trigger PROD deploy? (yes/no) " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted. No push made."
  exit 1
fi

echo ""
echo "Pushing origin/main → origin/production…"
git push origin origin/main:production

echo ""
echo "✓ Production branch updated. Vercel will deploy within ~1-2 minutes."
echo "  Check: https://vercel.com/andrewdavidullmann-9510s-projects/candid/deployments"
