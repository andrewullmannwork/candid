# Thesaurus Phase 0.5 — your review queue (S167)

Two files. **One to fill, one to hold.**

---

## 1. `news-classification-sheet.tsv` — FILL THIS (feeds mig 148)

62 new-concept services the resolver couldn't place against today's 69-slug catalog. I pre-proposed a verdict + slug for each; **you confirm by exception** (most rows just need `OK`).

Open in **Numbers / Excel** (it's tab-delimited). You only need the **`RULING`** column:

| You write in RULING | Meaning |
|---|---|
| `OK` | accept my proposed verdict/slug/category as-is |
| *(a correction)* | edit the `proposed_slug` / `proposed_category` / `proposed_verdict` cells to the right values, then put `OK` |
| `DROP` | not a real service / junk |
| *(blank)* | I treat as unreviewed — needs another look |

Context columns (don't edit): `family`, `occ` (cross-doc frequency), `service`, `nearest_concepts`, `insurers`, `note`.

**Verdict vocabulary** (only if you're correcting one):

| verdict | meaning |
|---|---|
| `synonym` | maps to an **existing** slug — put that slug in `proposed_slug` |
| `is_a` | a child of an existing slug — parent in `is_a`, child name in `proposed_slug` |
| `N1` | new peer slug in an **existing** category |
| `N2` | new peer slug **+ new** category |
| `N3` | completes the rx role enumeration (tier # is a modifier, never in the slug) |
| `N4` | new catch-all parent (with `is_a` children) |

Worth your eyes especially: the `REVIEW` row ("Other Eligible Providers") and the sensitive families (abortion, sterilization, contraceptives) where the category/slug naming is your call. Save as TSV (or CSV — I'll convert).

---

## 2. mig 147 — HOLD (don't apply standalone)

The approved + reviewed schema migration now lives in the **standard folder**:
`candid/supabase/migrations/147_thesaurus_component_pos_indications.sql` (also committed on branch `candid/backend-thesaurus-phase0-harness` @ `8a14361` for the PR).

**Don't apply to PROD on its own** — the re-key breaks the canonical upsert at `canonical-match.ts:646` until the 4-col `onConflict` fix ships in the PR. It applies as part of the **bundle** (147 + 148 + RPC + coupling), after the transform dry-run + your go.

---

## What happens with your fills

Your filled RULINGs → **mig 148** catalog data (new categories + slugs + concepts + indications) → transform **dry-run** (lossless proof, I show you) → apply the bundle to PROD → **after-score** gate (resolver vs your 813-answer oracle).
