# Candid — Admin Operations Manual

**Last updated:** 2026-07-08
**Canonical copy:** this repo (`docs/admin-operations.md`). Mirrored to the vault (`CandidX/01-Admin-Operations-Manual.md`).
**Rendered in-app at:** `/admin/ops` — each admin page links here via its "📖 Ops" header link, anchored to its section.
**Purpose:** step-by-step guide for operating the Candid admin panel. Train new operators from this; keep it current when an admin tool changes.

---

## Access

`/admin`

1. **Firebase account** logged in at candidclaim.com.
2. **Admin flag**: `is_admin = true` on your row in the Supabase `users` table.
3. **Admin password**: entered at the password gate on first visit (durable per-IP rate limit + progressive lockout + Turnstile; the cookie lasts 24h). Config lives in the `admin_login_hardening_v1` flag; the password is the `ADMIN_PASSWORD` env var.

**URL:** https://www.candidclaim.com/admin/ (bare `/admin` redirects to the To-Do Center.)

## How to read this manual

Sections below mirror the **sidebar groups** exactly, so the doc navigates like the panel. Each entry states:

- **What it's for** — one line.
- **What you do here** — the actions available. ⚠ marks an action that **mutates data** or is otherwise consequential.
- **Watch out** — cautions, blast radius, gotchas (only where they matter).

Two nav groups are **read-only / dormant by design** ("Data Quality · Monitoring") — empty queues there usually mean "flag off," not "broken." Those cases are called out per page.

---

## To-Do Center

`/admin/dashboard`

**What it's for.** The landing view and daily starting point. Aggregates pending counts across every action queue (corrections, document review, appeals, tickets, paused users, …) with a short preview of each, so you can see at a glance what needs attention and jump straight to it.

**What you do here.** Read the counts, click a tile to open the underlying queue. No mutations happen on this page.

---

## Queues

### Document Review

`/admin/documents/review`

**What it's for.** The main document-processing queue — approve/reject/reprocess uploaded documents and triage adversarial-PDF flags.
**What you do here.** Filter by status (Pending Review / All / Processed / Error / Queued / Rejected). Expand a card for classification, insurer-mismatch, and linked-plan detail. ⚠ **Approve** (runs the processing pipeline), ⚠ **Reject**, ⚠ **Reprocess** (error docs), ⚠ **Approve All / Reject All** (bulk), ⚠ confirm/clear an **adversarial flag**, ⚠ **Block hash** (adds to the blocklist).
**Watch out.** Bulk **Reject** is irreversible — the user must re-upload. "Stuck" (processing >24h) vs "Error" have different reprocess semantics. Adversarial confirm/clear is a security-triage decision.

### Hash Blocklist

`/admin/documents/blocklist`

**What it's for.** A SHA-256 file-hash blocklist that hard-rejects known-bad/adversarial uploads before they hit storage or the classifier.
**What you do here.** ⚠ **Add hash** (with reason/notes) · ⚠ **Remove hash**. Listing is read-only. Also reachable inline via "Block hash" on Document Review.
**Watch out.** A blocked hash silently rejects every future upload that matches it. The reason/notes field + `added_by_email` are the only audit trail.

### Review Queue

`/admin/review-queue`

**What it's for.** The unified Pattern-1 queue for parser-emitted unknowns: proposed service-catalog slugs, billing-code concepts, and bill-integrity "fires" (sign violations, sum mismatches).
**What you do here.** ⚠ **Promote** (insert into `service_catalog`), ⚠ **Reject**, ⚠ **Merge** (alias a proposed slug into a canonical one). Bills tab: ⚠ **Dismiss / Escalate / Resolve**. Concept-side promotion is intentionally SQL-only (no button).
**Watch out.** Merge/Promote have real downstream effects (aliasing, reprocess-on-match). This page's alias-**Merge** is a *different* mechanism from Benefit Pipeline's service-**Merge** (which migrates rows and sets `merged_into_id`) — use Review Queue for a new proposed slug, Pipeline for an existing catalog duplicate.

### Benefit Corrections

`/admin/corrections`

**What it's for.** Review and apply user-submitted coverage corrections (copay, coinsurance, coverage, …) onto canonical plan data.
**What you do here.** ⚠ **Approve / Reject** (status) · ⚠ **Apply** (writes `canonical_plan_services` via `applyPromotionEvent`, recorded as `admin_override`).
**Watch out.** The producer (the /plan "flag incorrect" submit) is gated by the `benefit_corrections` feature flag — **if that flag is off, this queue stays empty**; verify it on Feature Flags. **Apply** returns a 409 when a service has multiple cost-share cells, forcing you to apply the correct one manually rather than guessing. (Route note: the API lives at `/api/plan/corrections`, not `/api/admin/...`.)

### SBC Tickets

`/admin/sbc-tickets`

**What it's for.** Track manual outreach to obtain missing Summary-of-Benefits-and-Coverage documents from insurers.
**What you do here.** ⚠ **Update status** (pending / in_progress / awaiting_response / received / failed / escalated) · ⚠ **Log attempt** (increments the counter, auto-escalates at `max_attempts`) · ⚠ **Add note** (timestamped history). Tiers: User Request (red) / Known Gap (amber) / Stale (gray) / Sweep (blue).
**Watch out.** This is a human-outreach workflow — "attempts vs max_attempts" and `escalation_stage` drive the auto-escalation.

### Support Tickets

`/admin/tickets`

**What it's for.** Triage user support requests (`support_tickets`).
**What you do here.** ⚠ **Update status** (open / in_progress / resolved / closed) via the dropdown.
**Watch out.** **Replies happen in Slack**, not here — the `#support` thread auto-emails the user via Resend (`/api/slack/events`). This page only moves status; it doesn't send messages. (The row view is slightly behind the live ticket schema — category/attachment/linked-doc aren't shown yet.)

### Insurer Appeals

`/admin/insurer-appeals`

**What it's for.** The insurer appeals-address registry queue — the canonical surface for reviewing user/parser-proposed appeals addresses (and the target of the "new proposal" Slack alert).
**What you do here.** ⚠ **Accept** a pending proposal (optionally editing the address fields first) · ⚠ **Reject** · ⚠ **Revise** an already-accepted address directly. Also surfaces stale addresses and coverage gaps.
**Watch out.** **Revise writes shared `insurer_catalog` data used by every plan/user under that insurer — with no confirmation and no versioning.** A bad edit silently corrupts shared data. (This page is the maintained superset; `/admin/claims` still shows an older, read-mostly fork of the same queue — see the Claims entry.)

### Cost-Cap

`/admin/cost-cap`

**What it's for.** Manage the $10/user/day Haiku spend cap — the only lever to unblock a user who hit it.
**What you do here.** See paused users (7-day window). ⚠ **Unfreeze** (clears the pause, optional cost reset) · ⚠ **Set override cap** (per-user `override_cap_usd`). Both audit-logged.
**Watch out.** This is a production spend guardrail — an over-generous override lets a user run unbounded Haiku cost. Confirmation is a `window.prompt`.

---

## Claims & Plans

### Claims and Disputes

`/admin/claims`

**What it's for.** An aggregator view over two sub-queues: disputes missing a plan for their claim year, and insurer-appeals (pending / stale / gaps).
**What you do here.** ⚠ **Accept / Reject** insurer-appeal proposals (shares the review route with Insurer Appeals). The disputes-missing-plan-year section is read-only context.
**Watch out.** The insurer-appeals half here is the **older fork** and lags `/admin/insurer-appeals` (which gained edit-before-accept + revise-address). Reconciliation is planned — until then, prefer **Insurer Appeals** for appeal-address work; use this page for the **missing-plan-year** view it uniquely owns.

### Plan ACA Overrides

`/admin/plan-aca-overrides`

**What it's for.** Correct the ACA-compliance flag on plans where it was *inferred* (not attested) — e.g. grandfathered plans a user reports as an exception.
**What you do here.** ⚠ **Mark ACA / Mark not ACA** (optional free-text reason) — updates `is_aca_compliant` and sets `aca_compliance_basis = 'admin_override'`; audit-logged.
**Watch out.** Compliance-sensitive — this flag feeds downstream claims/dispute logic. There's no confirm dialog and the reason is optional; double-check before flipping.

---

## Data Quality · Needs action

### Code Identity Review

`/admin/code-identity-review`

**What it's for.** The main triage queue for billing-code identities (`billing_code_identity`) — Proposed / Corroborated / Admin Verified tabs.
**What you do here.** Set a `service_slug` and ⚠ **Promote** to bypass the ≥3-vote corroboration threshold (via `promote_with_slug`), which also backfills peer `claim_line_items`.
**Watch out.** Promotion backfills other users' claim rows. There's **no undo here** — to reverse, use **Demote** on the Code Identity Seeds page.

### Code Identity Disambiguate

`/admin/code-identity-disambiguate`

**What it's for.** Resolve ambiguous two-candidate ties the Haiku description-matcher couldn't settle (`code_identity_admin_review_queue`).
**What you do here.** ⚠ **Resolve** (promote the winning slug, reject the sibling, backfill peer line items) · ⚠ **Decline both** (both → `admin_rejected`).
**Watch out.** You're changing the trust of a slug already written to live `claim_line_items.service_slug`. The decline reason goes to the audit log only.

### Promotion Quarantine

`/admin/promotion-quarantine`

**What it's for.** The ID-Block anti-Sybil/replay corroboration quarantine — per-cluster/per-user inventory of promotions withheld pending source-independence checks, plus a live gate-config editor.
**What you do here.** ⚠ **Confirm / Clear** a held row (re-applies a withheld canonical promotion) · ⚠ edit thresholds + **shadow/active mode** in the config editor.
**Watch out.** Confirm/Clear promotes a canonical; `mode = active` starts **withholding real promotions**. The gate currently runs in **shadow** (`id_block_corroboration` flag; holds nothing — 0 rows). Read the config carefully before flipping shadow → active.

### Benefit Pipeline

`/admin/pipeline`

**What it's for.** The ingestion ops hub — four tabs: insurer **Discovery Queue**, **Insurer Catalog** (SBC-scrape automation), **Service Catalog** (taxonomy CRUD), and **Document Type Review** (low-confidence doc-type triage).
**What you do here.** ⚠ **Assign insurer / update status / reprocess** (Discovery) · ⚠ **Edit SBC URL / Trigger scrape / Mark verified** (Catalog) · ⚠ **Add / delete / merge / bulk-categorize** services + category management (Service Catalog) · ⚠ **Reclassify doc type** (Document Type Review).
**Watch out.** **Scrape** hits an external network and can fail. **Bulk delete** requires typing `DELETE`. **Merge** migrates `plan_covered_services`/`claim_insights` rows across services with no dry-run — genuinely destructive.

---

## Data Quality · Monitoring

> Read-only or dormant-by-design. An empty page here generally means "flag off," not "broken."

### Code Identity Seeds

`/admin/code-identity-seeds`

**What it's for.** Manage the small, largely-static seed batch of billing-code identities from the pre-launch bootstrap (CMS/CDC/USPSTF/NUCC).
**What you do here.** ⚠ **Demote** (→ proposed) · ⚠ **Lock** (→ admin_verified). This is the **only UI that exposes Demote** (though the API accepts any id, not just seeds).
**Watch out.** Not a refilling queue — it grows only if the seed CLI is re-run.

### Canonical Quality

`/admin/canonical-quality`

**What it's for.** Observability + triage for CF-40 v4 promotion state, Layer-4 invalidation/drift telemetry, and the minority-divergence review queue.
**What you do here.** ⚠ Set `admin_disposition` / `divergence_type` / notes on invalidation & divergence rows (triage only — never touches canonical plan state).
**Watch out.** **Dormant by design** — `cf40_v4_algorithm` is off, so the backing tables are empty until Ing-D.1's rollout flips it. Empty ≠ broken.

### Canonical Match Decisions

`/admin/canonical-match-decisions`

**What it's for.** Read-only observability for the `findOrCreateCanonicalPlan` matcher (summary / signature-dup / near-miss views), written on every match/create.
**What you do here.** Read the metrics. Watch `distinct_canonicals_count > 1` and near-misses. No mutations.

### Recoding Outcomes

`/admin/recoding-outcomes`

**What it's for.** Group disputes where the insurer reprocessed under a different billing code, and suppress a recoded-code pattern from future dispute-letter recommendations.
**What you do here.** ⚠ Toggle `do_not_surface_in_letters` for a `(code, code_type)` pair; audit-logged.
**Watch out.** **Broad blast radius** — one toggle changes what the peer-code engine recommends for that code across *all* users, not one dispute. Reversible, but the scope isn't obvious.

### Cost per Canonical

`/admin/cost-per-canonical`

**What it's for.** Per-canonical Haiku parse-cost rollup (7/30/90d), spike ratio vs the 30-day baseline, and the recent alert log.
**What you do here.** Read-only (window filter). A daily cron (`cost-per-canonical-alerts`, 09:00 UTC) posts real Slack spike alerts.

### Auto-Reparse Stats

`/admin/auto-reparse-stats`

**What it's for.** Per-field fire/trigger/outcome/cost stats for the post-promotion auto-reparse triage hook (Ing-A).
**What you do here.** Read-only stats.
**Watch out.** **Dormant by design** — `auto_reparse_enabled` is off, so the hook no-ops and `auto_reparse_field_frequencies` stays empty.

### Parse Audit Runs

`/admin/parse-audit-runs`

**What it's for.** A recall/precision/cost dashboard for the offline parse-harness, with per-field expected-vs-actual drill-down.
**What you do here.** Read-only.
**Watch out.** This is a **dev/QA tool** — the table is populated only by manually running `scripts/parse-harness.ts`. "No rows" just means the harness hasn't been run recently.

---

## Config

### Settings

`/admin/settings`

**What it's for.** System-level flags controlling document processing (`feature_flags` table): OCR on/off, auto-process, daily/monthly page limits, AI extraction, upload limits.
**What you do here.** ⚠ Toggle booleans / edit numeric values inline — takes effect immediately (server cache cleared).
**Watch out.** Environment variables in `.env.local`/Vercel **silently override** DB values (no UI indicator). Toggling OCR/extraction off stops that pipeline for all users. (This is a *different* system from Feature Flags — see below.)

### Feature Flags

`/admin/flags`

**What it's for.** The product feature-flag rollout console (`feature_flag_rules` table) — global / percentage / user-targeted, plus a free-form JSON `config` per flag. Consumed by 30+ lib modules (parser, disputes, claims, plan_doc).
**What you do here.** ⚠ Toggle enabled · ⚠ change targeting · ⚠ add a flag · ⚠ edit the JSON `config`.
**Watch out.** The JSON `config` is **not schema-validated** here — only "must be a JSON object." Some flags (e.g. `doc_type_override_v1`) have a **dedicated page** with real bounds-checking that this generic editor bypasses — prefer the dedicated page when one exists.

### Upload Settings

`/admin/upload-settings`

**What it's for.** The dedicated, validated tuner for the `doc_type_override_v1` flag: kill switch + classifier-confidence threshold + SBC max-pages (backs `effective-doc-type.ts`).
**What you do here.** ⚠ Toggle enabled · ⚠ edit the numeric thresholds (validated: 0–1 float, 1–200 int); audit-logged.
**Watch out.** The kill switch affects live upload classification. This edits the **same row** as the generic Feature Flags editor — prefer this page so you get validation, and avoid two admins clobbering each other across the two UIs.

### Classifier Settings

`/admin/classifier-fallback-settings`

**What it's for.** Three classifier-defense knobs (`classifier_haiku_regex_fallback_v1`): the Haiku-failure fallback mode, the bill-parser SBC sanity gate, and the doc-type confirmation-modal threshold — all consumed live by the upload/process pipeline.
**What you do here.** ⚠ Toggle / edit thresholds; changes real classification behavior on save.
**Watch out.** This is a **safety kill-switch** with three interacting defenses — know what each does before touching it during an incident.

---

## Growth

### Growth Metrics

`/admin/growth`

**What it's for.** The start of the metrics dashboards: signups → uploads by first-touch channel (`users.first_touch`, mig 203). The one growth metric — **uploads by source** — plus attributed %, top campaigns, and an 8-week trend. Window toggle: 7d / 30d / all-time.
**What you do here.** Read-only. Weekly ritual (GTM playbook 04): note the biggest funnel drop + which channel produces uploads (not clicks); kill channels at ~0 after 30 days. Raw traffic (impressions / clicks / queries / AI citations) deliberately lives in the linked GSC / Bing / Bing-AI-Performance panels — Candid runs no client-side analytics (S199).
**Watch out.** `(direct / untagged)` bundles pre-2026-07-12 users (attribution didn't exist yet) with genuine direct visits. If **new** signups suddenly go ~100% untagged, suspect the capture path broke (`FirstTouchCapture` in the root layout → `/api/auth/sync` persist), not that every channel died at once.

---

## Accounts

### Users

`/admin/users`

**What it's for.** User lookup and account management — inspect a user's profile, documents, consent history, and Stripe status; or erase them on request.
**What you do here.** Search by email/name; expand a card for full detail. ⚠ **Delete All User Data** — cascades across documents, storage, `support_tickets`, `consent_events`, `stripe_customers`, `profiles`, `finding_dismissals`, `insurer_appeals_confirmations`, the `users` row, **and the Firebase Auth account**. Requires typing `DELETE`. Admin users can't be deleted. Audit-logged.
**Watch out.** Irreversible and cross-system (Supabase + Storage + Firebase). If a step fails mid-cascade there's no rollback — verify the account is fully gone and clean up any remnant.

### Subscriptions

`/admin/subscriptions`

**What it's for.** Manage Stripe subscriptions.
**What you do here.** ⚠ **Cancel** (confirm + optional reason; cancels all active subs, sets DB to canceled/free) · ⚠ **Refund** (refunds the most recent charge).
**Watch out.** These move **real money** and are irreversible. (Known gap being fixed: this route doesn't yet write to the admin audit log — cancels/refunds currently leave no audit trail.)

### Consent Audit

`/admin/consent`

**What it's for.** The compliance-facing, cross-user audit trail of consent grant/revoke events (`consent_events`).
**What you do here.** Read-only (last 200 events): user email, consent type, version, granted Y/N, timestamp.
**Watch out.** "Immutable" holds for *users* (RLS) — but service-role flows (Users → Delete, and the CHD right-to-erasure revoke) **do** hard-delete `consent_events` rows, so the trail isn't immutable against admin-initiated deletion.

---

## Deprecated / removed (do not restore)

- **Site Copy** (`/admin/copy`) — the `site_copy` table was never wired to a renderer; the live site is hardcoded. Removed from the sidebar; slated for deletion.
- **Waitlist** (`/admin/waitlist`) — the waitlist product was retired at public launch (S67); `/api/waitlist` returns 410. Removed from the sidebar.
- **`/admin/documents` (bare)** — a redirect shim to Document Review; being replaced with a config-level redirect.

## Changelog

- **2026-07-08** — Rewritten to cover all active pages (was ~10 of 32, all pre-April). Regrouped to match the redesigned sidebar; added Data Quality (Code Identity, Canonical, Promotion Quarantine, Recoding, Cost, Auto-Reparse, Parse Audit), Insurer Appeals, Cost-Cap, Corrections, Review Queue, Plan ACA Overrides, Classifier/Upload Settings, Claims. Page headings cleaned so each slugs to its `admin-nav` `opsSlug` (routes moved to sublines). Marked Site Copy + Waitlist deprecated.
