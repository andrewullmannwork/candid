@AGENTS.md

# Candid Development Rules

## Mandatory Local Verification (Before Every PR)

Every code change MUST be verified locally before creating a PR. This is non-negotiable.

### Pre-PR Checklist (run in order, all must pass):

1. **Type check**: `npx tsc --noEmit`
2. **Lint**: `npx eslint . --max-warnings 50`
3. **Build**: `npm run build`
4. **Local smoke test**: Start the dev server (`npm run dev`), then verify:
   - App loads at `http://localhost:3000`
   - Sign-in works (email/password)
   - Navigate to the pages affected by your changes
   - Confirm no console errors on affected pages
   - Test the specific feature/fix end-to-end in the browser

If any step fails, fix it before proceeding. Do NOT create a PR with known failures.

### How to Run Local Smoke Tests

Use the Claude Preview MCP tool:
1. `preview_start` with name `candid-dev` to launch the dev server
2. `preview_screenshot` to verify the page loads
3. `preview_eval` to check for console errors
4. Navigate to affected routes and verify visually

### PR Workflow

1. Run the Pre-PR Checklist above
2. Commit with descriptive message
3. Push to feature branch
4. Create PR via `gh pr create`
5. Wait for CI to pass
6. Present PR to admin for review

## Feature Flag Protocol

All new user-facing features MUST be behind a feature flag before merging to main. Use the existing `feature_flag_rules` table and `isFeatureEnabled()` from `src/lib/config/product-flags.ts`.

Steps:
1. Add a flag check in the code path (see `process-plan.ts` for examples)
2. Create a migration to seed the flag row (disabled by default)
3. Test locally with the flag enabled for your user
4. After merging, enable the flag for test users via `/admin/flags`
5. Once verified in production, enable globally

## Data Architecture Rules

See `data_architecture.md` in the vault for the full schema reference.

1. **Every upload enriches the platform.** User documents improve data for all users on the same plan.
2. **Canonical over duplicated.** One shared plan record per (insurer, plan_name, state, year).
3. **Confidence-scaled.** Single-source = 0.5, multi-source = higher, admin-verified = 1.0.
4. **User-specific overlays.** Canonical plans hold shared coverage. Per-user records hold personal data.
5. **Consent-first aggregation.** All cross-user data is anonymized. Individual records never exposed.
6. **Schema traces to product.** Every table should map to a product scenario.
7. **Store finest grain, display right level.** Capture billing codes even when displaying service summaries.
