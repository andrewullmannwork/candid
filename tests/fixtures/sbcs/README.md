# SBC Fixtures

Real Summary of Benefits and Coverage (SBC) PDFs paired with hand-annotated `expected.json` ground-truth values. Used to:

1. Test `src/lib/plan/sbc-parser.ts` against real-world layout variations.
2. Drive Phase 5 cross-tier match validation against `findOrCreateCanonicalPlan` (per [[plans/master_data_pipeline_hardening]] Phase 5 carry-forward).
3. Catch parser regressions across insurer-specific formatting.

## Slug convention

Each subdirectory is `<insurer-slug>-<state>-<plan_year>-<metal-or-name>-<plan-type-or-variant>/`:

- `<insurer-slug>` — kebab-case carrier name (e.g. `blue-shield`, `ambetter`, `wha`).
- `<state>` — two-letter lowercase (e.g. `ca`).
- `<plan_year>` — four-digit year the plan was effective.
- `<metal-or-name>` — ACA metal tier with AV suffix (`bronze-60`, `silver-70`, `silver-87`, `gold-80`) OR carrier-specific plan name when not on the marketplace (`premier`).
- `<plan-type-or-variant>` — `ppo`, `hmo`, `epo`, `pos`, or a variant flag like `hdhp`. Omit when the plan name already encodes it.

Two files per slug:
- `sbc.pdf` — the verbatim source document. May be a clean ~6-12 page SBC OR a bundled PDF with the SBC inside (e.g. SBC + child dental SBC + EOC). Bundled PDFs intentionally exercise the parser's "find SBC within mixed PDF" path.
- `expected.json` — hand-annotated ground-truth values. See [_schema.md](_schema.md).

## Diversity matrix (current set: 7 SBCs)

| Slug | Insurer | State | Plan year | Plan type | Metal | Marketplace | Notes |
|---|---|---|---|---|---|---|---|
| ambetter-ca-2024-bronze-60-hdhp | Centene (Ambetter / Health Net CA) | CA | 2024 | PPO | Bronze 60 | individual (Covered California) | HDHP, HSA-eligible |
| ambetter-ca-2024-silver-87 | Centene (Ambetter / Health Net CA) | CA | 2024 | PPO | Silver 87 | individual (Covered California) | CSR-enhanced silver (87% AV) |
| ambetter-ca-2024-gold-80 | Centene (Ambetter / Health Net CA) | CA | 2024 | PPO | Gold 80 | individual (Covered California) | — |
| blue-shield-ca-2025-bronze-60-ppo | Blue Shield of California | CA | 2025 | PPO | Bronze 60 | shop (Covered California Small Business) | Bundled PDF (SBC + child dental + EOC) |
| blue-shield-ca-2025-silver-70-ppo | Blue Shield of California | CA | 2025 | PPO | Silver 70 | shop (Covered California Small Business) | Bundled PDF |
| blue-shield-ca-2026-silver-70-hmo | Blue Shield of California | CA | 2026 | HMO | Silver 70 | shop (Covered California Small Business) | Bundled PDF, Access+ network |
| wha-ca-2026-premier-hmo | Western Health Advantage | CA | 2026 | HMO | (off-marketplace) | employer (County of Sacramento) | $0 deductible, $15 PCP — rich employer plan |

### Cross-tier subset (Phase 5 match validation target)

Three Ambetter CA 2024 PPO SBCs share insurer + state + plan_year + plan_type and span Bronze → Silver → Gold. `findOrCreateCanonicalPlan` must NOT score ≥ 0.9 on cross-tier merges among these three.

### Plan-type subset

- **HDHP**: `ambetter-ca-2024-bronze-60-hdhp`
- **HMO**: `blue-shield-ca-2026-silver-70-hmo`, `wha-ca-2026-premier-hmo`
- **PPO**: remaining four

## Known gaps (deliberately deferred to v1.5 fixture expansion)

- No EPO, POS, or Catastrophic plans.
- No Platinum tier (WHA Premier is rich enough to be Platinum-equivalent but is off-marketplace; no formal AV assigned in source).
- No standard (non-CSR, non-HDHP) Silver or Bronze.
- All California — no geographic diversity.
- Three insurers only (Centene/Ambetter, Blue Shield, WHA).
- Plan years span 2024-2026 but no SBC older than 2024 (ACA SBC template was stable across this period; older variants would test pre-2020 layouts).
- No HHS standardized SBC templates (1C.1 spec asked for these "if available" — none located in HHS public archive at fixture creation).

Adding fixtures: drop a new slug dir + `sbc.pdf` + annotated `expected.json` + update the diversity matrix above.

## Annotation workflow

1. Read the SBC PDF cover-to-cover; confirm coverage period, plan type, metal level.
2. Populate `expected.json` per [_schema.md](_schema.md) — every field with a `null` placeholder either does not appear in this SBC or is genuinely unspecified.
3. Cross-check derived values: total `in_oop_max_family` should equal 2× individual for embedded calculations, ≠ for aggregate.
4. Note any surprises in `notes` array (e.g. unusual benefit limits, CSR-specific copays, employer-sponsored richness).

## Source

Each SBC was retrieved from the carrier's public marketplace listing or the user's own enrollment portal. Files are unmodified from source download. PII is absent from carrier-issued SBCs by design (these are plan-level documents, not member-specific EOBs).
