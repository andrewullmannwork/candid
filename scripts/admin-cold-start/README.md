# Admin Cold-Start Seeding Scripts

**Purpose**: Seed `canonical_plan_services` for ~15-20 California plans (then expand to top-9 states) by uploading SBC PDFs through the admin-bypass code path (S102; mig 111). Unlocks Pattern 2 matching, Compare, and card-matching for new users; sets up the flywheel to take over.

**Status**: scaffolded in S102; first end-to-end run in S103.

**Pre-requisites**:
- Mig 111 applied to target DB (dev for smoke; PROD before bulk seed)
- Andrew's `users.is_admin = true` in target DB
- Local dev server running at `http://localhost:3000` (for dev smoke) OR PROD reachable
- `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` (already present; service-role bypass means no browser session token needed)
- Andrew's `users.id` UUID (`2ce55772-bdf1-4edd-bd16-215aa239990e`)

---

## Files

| File | Purpose |
|---|---|
| `types.ts` | Shared TypeScript types for manifest entries + outcome logs. |
| `manifest.example.json` | Template for the hand-curated SBC list. Copy → `manifest.json` → fill in real URLs. |
| `download.ts` | Reads `manifest.json`, downloads SBC PDFs to `seed-data/sbcs/{state}/{insurer-slug}/`, computes SHA-256, writes `download-log.jsonl`. |
| `add-local-pdf.ts` | Register an already-local PDF (skip download). Useful for smoke testing with a file you already have. |
| `seed-via-service-role.ts` | **Use this — not upload-as-admin.ts.** Service-role bypass: uploads each PDF directly via Supabase service-role client (no Firebase ID token needed), inserts documents row, calls quickClassify + effective-doc-type resolver, enqueues chunk processor, polls DB for completion. |
| `upload-as-admin.ts` | DEPRECATED — required Firebase ID token from browser; replaced by `seed-via-service-role.ts`. Kept temporarily; remove after S103. |
| `verify.ts` | Queries DB for each seeded canonical: `canonical_plan_services` row count + `canonical_promotion_events.event_type='admin_override'` row count. Emits pass/fail report. |

---

## Workflow

### 1. Build the manifest

For each plan to seed, populate one `ManifestEntry` in `manifest.json`. Capture from exchange browse sessions:

- **Covered California**: browse `apply.coveredca.com` (anon session); plan-details page exposes the SBC download link. Grab HIOS plan ID from the URL.
- **HealthCare.gov**: use the plan-finder; SBC link on each plan detail.
- **State exchanges (NY, PA, IL)**: per-state URL patterns; see `manifest.example.json` notes per source.
- **Insurer-direct** (when exchange link broken): pull SBC from insurer's website directly. Tag `source: "insurer_direct"`.

Critical: `sbc_url` MUST point at the Summary of Benefits and Coverage PDF, NOT the plan brochure. They are different documents (brochure ≠ SBC).

### 2. Download

```bash
ADMIN_USER_ID=<andrew-uuid> \
SUPABASE_URL=<dev-or-prod> \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
npx tsx scripts/admin-cold-start/download.ts manifest.json
```

Output: `seed-data/sbcs/{state}/{insurer-slug}/{seed_id}.pdf` files + `download-log.jsonl`.

Re-run safe: skips files already downloaded with matching hash.

### 3. Upload via service-role (admin bypass)

```bash
ADMIN_USER_ID=<andrew-uuid> \
BASE_URL=http://localhost:3000 \
npx tsx scripts/admin-cold-start/seed-via-service-role.ts
```

`SUPABASE_SERVICE_ROLE_KEY` + `NEXT_PUBLIC_SUPABASE_URL` are read automatically from `.env.local`.

Per-PDF flow (no HTTP layer; runs against DB directly):
1. Reads file + computes SHA-256
2. Uploads to Supabase storage at `{admin_user_id}/{documentId}.pdf`
3. INSERTs documents row (status='uploaded')
4. Calls `quickClassify` (imports candid module — no API call)
5. UPDATEs documents with classification + applies effective-doc-type resolver
6. `enqueueChunk` → chunk processor takes over
7. Polls DB `documents.status` every 5s until `processed` (or `error`/timeout)
8. Writes `upload-log.jsonl`

Pre-flight: ensures admin consent_events row exists (creates one if missing — admin self-grants; pattern 1 #14 audit-clear via admin user_id linkage).

Sequential (not parallel) to avoid Haiku rate-limit pressure.

### 4. Verify

```bash
SUPABASE_URL=<dev-or-prod> \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
npx tsx scripts/admin-cold-start/verify.ts manifest.json
```

Emits markdown report: per-canonical, did `canonical_plan_services` populate + did `canonical_promotion_events` record `admin_override`. Fail-fast on first canonical that didn't seed (lets Andrew investigate before bulk seed continues).

---

## Capturing Covered California SBC URLs (manual step for S103)

Andrew's workflow per S101 alignment:
1. Navigate to `https://apply.coveredca.com/` — start anonymous browse.
2. Enter zip code + income + family composition → reach plan-shop page.
3. For each plan card, click into plan details.
4. Find the "Download the Summary of Benefits and Coverage (SBC)" link near the brochure.
5. Right-click → "Copy link address". Paste into `manifest.json` as `sbc_url`.
6. Note the HIOS plan ID from the URL (14-char alphanumeric in path).
7. Note the insurer name + plan name from the page header.

Realistic capture rate: ~30-60 seconds per plan. 19 California plans = 10-20 min manual capture. Acceptable for first pass.

Future automation: build a Playwright scraper that walks the exchange + extracts SBC URLs. Out of scope for S103.

---

## Smoke test on dev (S103 first action, before bulk seed)

1. Build minimal manifest with `bs-bronze-60-ppo-clean-sbc.pdf` (the test file Andrew already uploaded 16x at `e8a5540d557b`).
2. Run `download.ts` (will download a fresh copy from CoveredCA).
3. Run `upload-as-admin.ts` on dev.
4. Run `verify.ts`. Expected:
   - `canonical_plan_services` for canonical `0de67fb0` populates ~30 rows (was 0)
   - `canonical_promotion_events` writes rows with `event_type='admin_override'`
   - Document parses to `status='processed'`
5. If smoke passes → apply mig 111 to PROD + ship branch as PR + repeat seed on PROD.
6. If smoke fails → investigate before bulk seed.

---

## Pattern 1 #14 audit invariant

After seeding completes:
- Every row in `canonical_plan_services` should have `source='admin_attested'` (for admin path) OR `source='multi_source_corroboration'` (organic path, future).
- Every `canonical_promotion_events` row from this session has `event_type='admin_override'` AND `fire_source='process-plan'` AND `actor_user_id=<andrew-uuid>`.
- Spot-check 5-10 rows against the source SBC manually (Haiku could misread; admin attestation doesn't auto-validate).
