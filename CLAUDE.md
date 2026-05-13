@AGENTS.md

# Platform Context

Before starting any work, review the platform context to understand WHY we're building:
- **NORTH STAR (read first):** `/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/Candid_10k.md` — 6-pillar spine + 4-service taxonomy (Benefits / Claim / Case / Care) + governance ritual. Every Subplan + commit + session traces to a pillar.
- **Full context:** `/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/Candid_Context.md`
- **Foundational data principles:** `/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/Candid_Data_Principles.md` — read before architectural decisions; the source of truth for canonical-write boundaries (Pattern 1 #14), corroboration thresholds (Pattern 1 #3), per-surface display gating (Pattern 1 #4), identity-fraud defense placement (Pattern 1 #15), and the data flywheel.
- **Initiative tracker:** `/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/Candid_Todos.md`
- **Detailed plans:** `/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/`

Candid creates certainty about healthcare costs through 4 services (Benefits / Claim / Case / Care) powered by a single data flywheel. Every implementation decision either improves the data we ingest (parser fidelity, cross-user corroboration), the UX/UI surfaces that turn that data into user value, or is required for the platform to legally exist and sustain itself — anything else is drift.

Key principles: upload-first not form-first, show value before paywall, every interaction enriches the data flywheel, the user always sends their own letters (CROA), old plan data is never deleted (claims reference it).

## Pillar Tag Rule (mandatory)

Per Candid_10k §2 + Candid_Doc_Organization §3: every PR commit + Subplan + session traces to a pillar:

- **P1** — Document Ingestion (parser fidelity, Pattern P-8, fixtures)
- **P2** — Cross-Service Data Flow (Pattern 1 corroboration, canonical promotion, identity-fraud defense)
- **P3** — UX/UI (visible state vocabulary, surface polish, navigation)
- **P4** — Infra / Tech Debt / Security (auth, observability, performance, vuln defense)
- **P5** — Legal / Compliance (CROA, ABA, CCPA/CPRA + WA MHMDA; HIPAA-out-of-scope confirmed Session 66)
- **P6** — Monetization (Stripe, marketplace flat fees, paid-tier gating)

PR titles + commit messages declare the primary pillar. Untaggable work is drift; redirect or restructure.

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

## Production Release Workflow (Session 81 change)

**Important — auto-deploy on merge is OFF.** Vercel's production branch was switched from `main` → `production` in Session 81 to gate PROD releases manually and reduce build costs. The behavior change:

- **Merges to `main`** → preview deploys only (Vercel builds them under the preview-environment limits, not as production)
- **Pushes to `production`** → trigger the single PROD deploy
- **No more "auto-deploy every PR to PROD"** — releases now batch by explicit promotion

### To ship code to PROD

After PR(s) merge to `main` and CI is green, promote main → production:

```bash
cd /Users/andrewullmann/Desktop/candid
git fetch origin
git push origin origin/main:production
```

Or via the convenience script:

```bash
./scripts/release-to-prod.sh
```

The script (a) fast-forwards `production` to current `main`, (b) shows the commits being shipped, (c) requires a `yes` confirmation. Use it when batching multiple PRs into one PROD deploy. Vercel will pick up the `production` branch push and auto-deploy from there.

### Hotfix path

For emergency PROD fixes, the workflow is unchanged from any other PR — merge to main, then `git push origin origin/main:production` to ship. The extra step is ~30 seconds of latency for the safety of explicit promotion.

### Do NOT

- Push directly to `production` from a feature branch — always go through `main`
- Reset/force-push `production` — it should only fast-forward from `main`
- Assume merge-to-main = deployed-to-prod (pre-Session-81 assumption; no longer true)

## Feature Flag Protocol

All new user-facing features MUST be behind a feature flag before merging to main. Use the existing `feature_flag_rules` table and `isFeatureEnabled()` from `src/lib/config/product-flags.ts`.

Steps:
1. Add a flag check in the code path (see `process-plan.ts` for examples)
2. Create a migration to seed the flag row (disabled by default)
3. Test locally with the flag enabled for your user
4. After merging, enable the flag for test users via `/admin/flags`
5. Once verified in production, enable globally

## Data Architecture Rules

Source of truth: `Candid_Data_Principles.md` (foundational decisions) + `Candid_Data_Patterns.md` (Pattern 1 — 15 universal hard rules; Pattern 2 — plan identity matching; Pattern M / O cross-references). Schema reference: `Candid_Schema_Reference.md`. Parsing patterns: `Candid_Parse_Patterns.md`. All under `/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/`.

1. **Every upload enriches the platform.** User documents improve data for all users on the same plan.
2. **Canonical over duplicated.** One shared plan record per (insurer, plan_name, state, year).
3. **Confidence-scaled with per-surface gating** (Pattern 1 #4). Single-source = 0.5, multi-source = 0.9, admin-verified = 1.0. Per-surface display rule: informational surfaces (Plan page, dashboard) show estimated/unverified data with state badges; legal surfaces (Dispute letter, Case File) HIDE non-cite-grade fields entirely per Pattern P-8 cite-grade gate. **CF-19 (Session 64) 6-state vocabulary**: `candid_verified` (Pattern 1 #3 corroborated, full green), `document_verified` (Pattern P-8 cite-grade from user's doc, dark green border), `found_in_document` (extracted from doc but verbatim absent or section misattribution, light green border), `estimated` (amber), `unverified` (rose), `hidden`. Aggregation worst→best: `unverified > estimated > found_in_document > document_verified > candid_verified`.
4. **User-specific overlays.** Canonical plans hold shared coverage. Per-user records hold personal data.
5. **Consent-first aggregation.** All cross-user data is anonymized. Individual records never exposed.
6. **Schema traces to product.** Every table should map to a product scenario.
7. **Store finest grain, display right level.** Capture billing codes even when displaying service summaries.
8. **User events write user-scoped only; canonical via explicit promotion** (Pattern 1 #14). First-parse uploads, re-parse, manual corrections, value disputes — all write to user rows (`insurance_plans`, `plan_covered_services`, `claim_line_items`). Canonical reference tables (`canonical_plans`, `canonical_plan_services`) populated ONLY via Pattern 2 identity creation OR Pattern 1 #3 promotion event when corroboration threshold met (currently ≥3 distinct users until P.2 Phone OTP). Direct user-driven writes to canonical tables are forbidden. Today's mig 064 RPC is known implementation drift — Phase 4.0.6 (Sessions 59-60) corrects with canonical promotion event mechanism.
9. **Identity-fraud defense at the onboarding pipeline, not the data layer** (Pattern 1 #15). For data sources where IDENTITY fraud is the dominant threat (provider portal, lawyer onboarding, future partner-portal submissions), defense lives at the ONBOARDING pipeline (Pattern O) — NOT at the quarantine layer (Pattern 1 #13). Pattern 1 #13 quarantine is for transactional outlier defense from already-authenticated users; identity-fraud defense ensures the submitter is who they claim to be BEFORE their data enters the pipeline.
