# Candid — Operations Runbook

**Last updated:** 2026-07-08
**Canonical copy:** this repo (`docs/operations-runbook.md`). Mirrored to the vault (`Operations Runbook.md`).
**Purpose:** how the platform actually runs — the live processes, the cron jobs, the flags, and how to deploy/operate them. Per-page admin instructions live in [`admin-operations.md`](./admin-operations.md). Deep architecture lives in the vault plan docs (linked inline).

**Stack:** Next.js 16 (App Router) + TypeScript + Tailwind · Supabase (Postgres + Storage + service-role) · Firebase Auth (client) · Google Document AI (OCR) · Anthropic Haiku (parsing) · Stripe · Resend · Slack · QStash · Cloudflare Turnstile.
**Production:** https://www.candidclaim.com · Supabase project `viahlyugpuviaskpdvce`.

---

## 1. Environments & deploy

- **`main`** auto-builds on Vercel on every push (preview/staging).
- **`production`** is a *separate tracked branch*. Promote by running **`scripts/release-to-prod.sh`** from the repo (fast-forwards `production` to `main` after CI is green). If the script's interactive prompt eats the pipe, the documented fallback is `git push origin origin/main:production`.
- **Never promote past red/pending CI.** Green CI on the PR is the gate; promote right after squash-merge.
- **Migrations**: SQL files in `supabase/migrations/`. Applied to PROD **manually via Supabase Studio**, not `supabase db push`. Gotcha: Studio can report "Success" while applying nothing — strip comments, schema-qualify, run **bare** statements (no wrapping `BEGIN/COMMIT`), and verify with a `SELECT`. Use `DROP + CREATE`, not `CREATE OR REPLACE TRIGGER` (PG14+). Always claim the next migration number before writing (parallel streams collide).
- **Flag flips**: boolean product flags via `feature_flag_rules` (`scripts/flags/flag-set.ts` or a dedicated admin page); int/config values via a `feature_flags` upsert (env → DB → default, 60s cache). Read live state with `scripts/flags/flag-state.ts`.

---

## 2. Document ingestion pipeline

```
upload → quick-classify (sample pages) → confidence gate → full processing → parse → processed
```

1. **Upload** (`POST /api/documents/upload`) — Firebase-auth; requires a `health_data_upload` consent event; stores to Supabase Storage `documents` bucket; hard-blocks known-bad SHA-256 hashes (`isHashBlocked`); creates a `documents` row (`uploaded`). Accepts PDF/JPEG/PNG/HEIC.
2. **Quick classify** (`src/lib/classifier/`) — OCRs a *sample* of pages and scores against 5 doc types (SBC, EOB, Itemized Bill, Insurance Card, Plan Document). Stores `classified_type` + `classification_confidence`.
3. **Confidence gate** — `≥0.8` → auto-process · `0.4–0.8` or a recognized type / user-selected type → `pending_review` (Slack + email to admin, email to user) · `<0.8` when the **user explicitly declared a healthcare type** → **escalate to full processing** (S269 — don't dead-end at the quick sample) · `<0.4` + "other" + no user type → `rejected`.
4. **Full processing** (`POST /api/documents/process`) — budget-checked; Document AI OCR in 15-page chunks; full-text re-classification (more accurate than the sample). **Per-page OCR recovery (S269)**: a page that *draws* text but decodes ~nothing (subset fonts w/ no ToUnicode) is sent to Document AI just for that page and spliced back — gated by `ocr_undecodable_page_fallback_v1` (config `{candidate_max_chars, min_text_ops, min_chars_per_op}`); off ⇒ byte-identical, and clean docs never hit Document AI.
   - **SBC / Plan doc** → parse benefits → `insurance_plans` + `plan_covered_services`; deactivate prior active plan; Slack alert on uncategorized services.
   - **EOB / Bill** → parse line items → audit engine → pricing data.

**Document statuses:** `uploaded` (stalled — investigate) · `processing` · `processed` · `pending_review` (→ Document Review) · `queued` (budget cap — auto-resumes) · `rejected` (re-upload) · `error` (retry). Full ops-triage in [admin-operations.md → Document Review](./admin-operations.md).

---

## 3. Parsing & the canonical flywheel

- **Haiku-first parsers** (SBC / plan-doc / EOC / bill / card) run on a streaming transport (`src/lib/haiku-client/base.ts`). Every field carries a per-field confidence + **cite-grade provenance** (`field_provenance`, Pattern P-8) — a `source_excerpt` proving where the value came from.
- **Pattern 1 promotion (the flywheel)**: user uploads write **user-scoped** rows only. A value promotes to the shared **canonical** layer (`canonical_plan_services` via `apply_promotion_event`) once **≥3 distinct verified users** corroborate it. Canonical reference tables are never written directly by user-facing code. Cold-start uses an **`admin_override`** promotion lever (below).
- **Service identity / thesaurus** — a shared resolver maps raw parsed service labels to canonical slugs via learned synonyms (`service_synonyms`), so "facility fee" and "hospital admission" resolve to one identity. Synonym-inferred values are shown as *estimates* and cite-gated before they can back a dispute letter (`cite_grade_gate_v1`).
- **CF-40 v4** — per-parse contribution scoring + canonical drift/invalidation detection. Shipped but **dormant** behind `cf40_v4_algorithm` (off); its admin surface is Canonical Quality.
- **ID-Block** — anti-Sybil/replay quarantine on corroboration (source-independence). Runs in **shadow** (`id_block_corroboration`); admin surface is Promotion Quarantine + the daily `id-block-reeval` cron.
- **Admin surfaces**: Review Queue (unknowns) · Code Identity (billing-code identities) · Canonical Quality / Match Decisions · Promotion Quarantine · Benefit Corrections. See [admin-operations.md](./admin-operations.md).
- Deep architecture: vault `Candid_Data_Patterns`, `service_thesaurus`, `Candid_Data_Principles`.

---

## 4. Disputes — letters v2 + deadlines

- **Grounds engine** (`src/lib/disputes/`, `dispute_grounds_v1`) — derives the dispute grounds from the claim/coverage state and computes a **capped recovery** (sum of grounds, clamped to exposure). A denial outranks a structural cost-share ground (classifier-parity CI lock).
- **Letter ladder + escalation** — outcome-driven (no-response / denied / needs-info / resolved-win / collections / new-problem). Provider grievances route to the provider **Compliance** dept; insurer grievances route to **Appeals**. Core dispute letters + debt-validation are free; final-notice / external-review are Pro. Escalation spawns the next rung as its own dispute (`POST /api/disputes/[id]/escalate`).
- **Deadline & follow-up engine** (`deadline-engine.ts`, `dispute_deadline_engine_v1`) — computes governing deadlines (plan-response 60d, FDCPA §1692g 30d, ERISA appeal 180d) from persisted dates; the `send-followups` cron mails graduated follow-up letters on a config cadence (`dispute_feedback_loop`).
- **Appeals-address registry** — user/parser-proposed insurer appeals addresses land in a Slack-alerted admin queue (Insurer Appeals); accepted addresses reuse across a user's same-insurer disputes.
- **Plan pinning** (`dispute_plan_pinning_v1`) — a dispute pins to the `insurance_plan_id` in effect for its claim year (mid-year plan changes).
- Post-launch obligations tracker: vault `plans/dispute-letters-v2-post-launch-tracker.md` (standing SoT — review each dispute session).

---

## 5. Cold-start seeding

- **Why**: so a new user sees real coverage data before ≥3-user corroboration exists. Public SBCs/EOCs are parsed and seeded into canonical with an `admin_override` promotion + a `seeded_via` tag (reversible/auditable).
- **How**: Sonnet sub-agents extract → the shared production pipeline persists under a gated seed mode → §14 probe + cite-grade + oracle re-score gates must pass before writes are kept; a snapshot/rollback path makes every run net-zero-able.
- **Status**: **Group B regeneration in progress** — re-deriving the ~1,300-plan seed through the *current* pipeline (fresh extraction complete; gated write finish pending). SoT: vault `plans/coldstart_regeneration.md`. Rollback filter: `documents.metadata.seeded_via` / `canonical_plans.seeded_via`.

---

## 6. Cron jobs

Authoritative schedule is `vercel.json`; every cron route verifies `CRON_SECRET` (constant-time `isAuthorizedCron`).

| Schedule (UTC) | Route | Purpose |
|---|---|---|
| `0 6 * * *` | `/api/cron/id-block-reeval` | Re-evaluate held ID-Block promotions; auto-release when legitimacy clears |
| `0 7 * * *` | `/api/cron/pii-audit` | Daily PII-exposure audit across CHD tables |
| `0 8 * * *` | `/api/cron/retry-stuck` | Retry documents stuck mid-processing |
| `0 9 * * *` | `/api/cron/cost-per-canonical-alerts` | Haiku parse-cost spike alerts → Slack |
| `0 14 * * *` | `/api/cron/send-followups` | Send graduated dispute deadline follow-up letters |
| *(route exists, not scheduled)* | `/api/cron/refresh-pricing` | Pricing refresh — present but not in `vercel.json` crons |

---

## 7. Feature-flag systems (there are two)

1. **`feature_flags`** — simple key/value (env → DB → default, 60s cache). Processing limits + int/config values (OCR budgets, `ASYNC_REDIRECT_MAX_PAGES`, upload limits). Edit via **Settings** / **Upload Settings** or a DB upsert.
2. **`feature_flag_rules`** — targeted rollouts (global / percentage / user) + free-form JSON `config`. Product features (`dispute_grounds_v1`, `thesaurus_phase1a_v1`, `cite_grade_gate_v1`, `ocr_undecodable_page_fallback_v1`, …). Edit via **Feature Flags** (generic, unvalidated) or a **dedicated page** when one exists (preferred — it validates).

Prefer the dedicated page over the generic JSON editor for any flag that has one (e.g. `doc_type_override_v1` → Upload Settings). Read live truth: `npx tsx scripts/flags/flag-state.ts`.

---

## 8. Cost controls & telemetry

- **Per-user Haiku cap**: $10/user/day (`haiku_spend_tracking`). A user who hits it is paused; unblock via **Cost-Cap** (unfreeze / per-user override).
- **Parse-cost telemetry**: `parse_cost_events` feeds the **Cost per Canonical** dashboard + the 09:00 spike-alert cron.
- **OCR budgets**: daily/monthly page caps in `feature_flags` (Settings). Kill switch: set `OCR_ENABLED = false` on a cost spike.

---

## 9. Data safety & compliance

- **PII redaction** at write chokepoints (`pii_redaction_enabled`) + the daily `pii-audit` cron.
- **Consent**: every grant/revoke writes `consent_events` (Consent Audit is the read view). **Right-to-erasure**: a consent revoke triggers full CHD + plan erasure keeping only de-identified canonical data; an in-flight-parse erasure write-guard (`erasure_write_guard`) fences races.
- **Third parties that receive identifiable CHD** (disclosed in the consent docs): Anthropic (Haiku — standard API, not trained on, ~30-day retention), Google Document AI (OCR), Supabase Storage. Keep the consent language truthful to this list.
- **Analytics**: GA4 + Vercel Analytics were **removed from authed CHD pages** (legal pass, S200/S202) — do not re-add analytics to pages that render health data.
- Deep detail: vault `plans/findings/legal-review-2026-06-11/`.

---

## 10. Integrations & where they live

| Service | Purpose | Notes |
|---|---|---|
| **Supabase** | Postgres + Storage + service-role | project `viahlyugpuviaskpdvce`; migrations via Studio |
| **Firebase Auth** | client-side user auth | ID token → verified server-side |
| **Google Document AI** | OCR (fallback + per-page recovery) | `pdfjs` is primary; DocAI is the fallback |
| **Anthropic (Haiku)** | document parsing | streaming transport; standard API |
| **Stripe** | subscriptions + payments | ⚠ still **test mode** until live keys are swapped (OPS.1) |
| **Vercel** | hosting + serverless + crons | auto-deploy `main`; promote via `release-to-prod.sh` |
| **Resend** | outbound email | inbound insurer email is handled separately |
| **Google Workspace** | inbound `support@`/`legal@`/`privacy@` | DNS setup is an open ops task (OPS.5) |
| **Slack** | admin alerts (support, appeals, cost, ID-Block) | inbound events HMAC-verified |
| **QStash** | async doc-processing queue | region-pinned `us-east-1`; signature-verified |
| **Cloudflare Turnstile** | bot defense (signup, admin login) | `turnstile_enforcement_v1` global |

---

## 11. Common ops tasks

| Task | How |
|---|---|
| Operate a specific admin page | [admin-operations.md](./admin-operations.md) → find the page |
| Process a stuck document | Document Review → Approve / Reprocess |
| Unblock a spend-capped user | Cost-Cap → Unfreeze |
| Disable OCR on a cost spike | Settings → `OCR_ENABLED = false` |
| Flip a product flag | dedicated admin page, or `scripts/flags/flag-set.ts` |
| Read live flag state | `npx tsx scripts/flags/flag-state.ts` |
| Deploy a code change to prod | merge on green CI → `scripts/release-to-prod.sh` |
| Apply a DB migration | write `supabase/migrations/NNN_*.sql` → apply in Studio (bare statements) → verify SELECT |

---

## Changelog

- **2026-07-08** — Refreshed from the 2026-04-06 version. Corrected deploy (production branch + `release-to-prod.sh`, Studio migrations — not `supabase db push`), replaced the stale admin-page table with a pointer to `admin-operations.md`, added the real cron list (`vercel.json`), the two flag systems, disputes v2 + deadline engine, cold-start regeneration, spend caps, PII/erasure/consent, and the S269 OCR-recovery pipeline change. Removed the stale GA4-on-CHD note (analytics were stripped from authed pages).
