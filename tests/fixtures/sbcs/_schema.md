# `expected.json` schema

Ground-truth shape for SBC fixture annotations. Mirrors `SBCParseResult` from [`src/lib/plan/sbc-parser.ts`](../../../src/lib/plan/sbc-parser.ts), extended with fields the parser does NOT yet extract but Phase 5 cross-tier matching needs.

## Shape

```json
{
  "fixture_metadata": {
    "slug": "ambetter-ca-2024-bronze-60-hdhp",
    "annotated_by": "andrew + claude session 43",
    "annotated_at": "2026-04-29",
    "source_pdf_pages": 12,
    "is_bundled_pdf": false,
    "sbc_page_range": "1-7",
    "notes": []
  },

  "plan": {
    "plan_name": "Health Net of CA: Bronze 60 HDHP Ambetter PPO",
    "insurer_name": "Centene",
    "insurer_brand_name": "Ambetter from Health Net of California",
    "employer_name": null,
    "plan_type": "PPO",
    "plan_year": 2024,
    "state": "CA",
    "metal_level": "bronze",
    "actuarial_value": 0.60,
    "csr_level": null,
    "is_hdhp": true,
    "hsa_eligible": true,
    "marketplace_type": "individual",
    "on_marketplace": true,
    "hios_id": null,
    "network_name": "Ambetter PPO",
    "coverage_period_start": "2024-01-01",
    "coverage_period_end": "2024-12-31",
    "coverage_tier": "individual_family",

    "in_deductible_individual": 7050,
    "in_deductible_family": 14100,
    "out_deductible_individual": 14100,
    "out_deductible_family": 28200,

    "in_oop_max_individual": 7050,
    "in_oop_max_family": 14100,
    "out_oop_max_individual": 25000,
    "out_oop_max_family": 50000,

    "in_coinsurance_default": null,
    "out_coinsurance_default": 0.50,

    "deductible_calc_method": "embedded",
    "combined_medical_rx_oop": true,
    "referral_required": false,

    "other_deductibles": null,

    "premium_total": null,
    "premium_employee": null,
    "premium_employer": null,
    "premium_subsidy": null,
    "premium_frequency": null,

    "minimum_essential_coverage": true,
    "minimum_value_standard": true
  },

  "services": [
    {
      "service_slug": "pcp_visit",
      "place_of_service": "office",
      "in_copay": null,
      "in_coinsurance": null,
      "in_deductible_applies": true,
      "in_copay_waiver_condition": null,
      "in_cost_description": "No charge after deductible has been met",
      "out_copay": null,
      "out_coinsurance": 0.50,
      "out_deductible_applies": true,
      "out_cost_description": "50% coinsurance",
      "oon_paid_at_in_network": false,
      "annual_limit": null,
      "annual_limit_value": null,
      "prior_auth_required": null,
      "penalty_no_precert": null,
      "covered": true,
      "coverage_conditions": null,
      "supply_limit_days": null,
      "home_delivery_copay": null,
      "step_therapy_required": null,
      "notes": null,
      "source_excerpt": "Primary care visit to treat an injury or illness — No charge after deductible has been met (preferred); 50% coinsurance (out-of-network)",
      "source_page": 2
    }
  ],

  "appeals_contact": {
    "address_line_1": null,
    "address_line_2": null,
    "city": null,
    "state": null,
    "postal_code": null,
    "phone": null,
    "source_excerpt": null,
    "source_page": null
  }
}
```

## Field semantics

### `fixture_metadata`

| Field | Type | Notes |
|---|---|---|
| `slug` | string | Must match the parent directory name. |
| `annotated_by` | string | Free-form; record session number. |
| `annotated_at` | ISO date | Annotation date, not plan effective date. |
| `source_pdf_pages` | int | Total PDF page count. |
| `is_bundled_pdf` | bool | True when the PDF contains content beyond the SBC (e.g. EOC, child dental SBC, glossary). Drives parser robustness testing. |
| `sbc_page_range` | string | "N-M" — the page range within the bundled PDF where the SBC itself sits. Equal to the full PDF range when not bundled. |
| `notes` | string[] | Free-form annotations: surprises, ambiguous values, parser-relevant quirks. |

### `plan`

Mirrors `InsurancePlanRow` from `src/lib/supabase/types.ts`. Additional fields not in the row:

| Field | Type | Why annotated |
|---|---|---|
| `insurer_brand_name` | string \| null | Marketplace-facing brand vs legal entity name. Ambetter is the brand; Centene is the legal entity. The parser's insurer-detection regex maps both to "Centene". |
| `metal_level` | "bronze" \| "silver" \| "gold" \| "platinum" \| "catastrophic" \| null | Required for Phase 5 cross-tier match validation. Null when off-marketplace and no formal AV. |
| `actuarial_value` | number \| null | 0.60, 0.70, 0.80, 0.87, etc. Records the AV variant within the metal tier. |
| `csr_level` | 73 \| 87 \| 94 \| null | Cost-sharing reduction enhancement level for low-income silvers. Null for standard plans. |
| `is_hdhp` | bool | True when the plan is HSA-eligible high-deductible. The parser detects this from `plan_type == "HDHP"` but most HDHP carriers list plan_type as PPO/HMO and put HDHP in the plan name. |
| `hsa_eligible` | bool | Usually equals `is_hdhp` but technically distinct (HDHPs that fail other IRS rules are not HSA-eligible). |
| `marketplace_type` | "individual" \| "shop" \| "employer" \| "medicare" \| "medicaid" \| null | SHOP/Small Business is regulatorily distinct from individual marketplace. |
| `on_marketplace` | bool | Whether the plan was sold on a public ACA exchange (FFM, SBE, or SHOP). |
| `hios_id` | string \| null | 14-character HIOS plan ID when the plan appears in CMS PPL. Null for off-marketplace plans. |

Numeric monetary fields are integer USD (no cents). Coinsurance is a decimal between 0 and 1 (`0.50` not `50`). Booleans use `true`/`false`/`null` (null = not specified in this SBC).

### `services`

Array of `SBCParsedService` objects, one per service the SBC explicitly addresses (including services in the "Other Covered Services" section). Snake-case in JSON; the parser uses camelCase TypeScript fields — converters live in the parser test harness.

`service_slug` MUST match an entry in `service_catalog` (see `src/lib/plan/service-seed.ts`, mirrored to SQL by `supabase/migrations/010_service_catalog_seed.sql`). If the SBC describes a covered service with no matching slug, **add the slug** in service-seed.ts plus a migration — do NOT silently drop the coverage. Recent additions: `routine_eye_exam_adult` (migration 054).

#### Prior authorization conventions

`prior_auth_required: boolean | null` is the structured signal — `true` means PA can apply to this service in some form, `null` means the SBC does not mention PA. The verbatim qualifier (e.g. "Some procedures require PA", "Required for non-emergency only", "Required for select drugs") lives in `coverage_conditions` exactly as the SBC states it. There is no separate `prior_auth_scope` enum; the verbatim text is the source of truth and avoids the ambiguity of bucketing every qualifier into "all" or "some".

#### Substance Use Disorder (SUD) parity entries

Many SBCs bundle SUD coverage into mental health rows (page-section header "Mental health, behavioral health, or substance abuse services"; ER row text "medical, mental health and substance use disorders"). When the SBC text mentions substance use anywhere, ground truth includes BOTH:

- `mental_health_outpatient` / `mental_health_inpatient` (verbatim from SBC), AND
- `substance_abuse_outpatient` / `substance_abuse_inpatient` (mirror with identical cost-sharing per ACA mental health parity)

The parser performs this derivation as a post-process step in `parseSBCText` (added by migration 054 / session 43 PR). Phase 5 cross-tier validation can rely on both slugs being populated.

### `appeals_contact`

Single object (not array) — SBCs have at most one appeals contact block on the back page. All-null when the SBC does not include this section.

## Conventions

1. **Verbatim source excerpts.** `in_cost_description`, `out_cost_description`, and `source_excerpt` quote the SBC text verbatim. Preserve the exact phrasing including line breaks (use `\n` if needed).
2. **`in_*` vs `out_*`.** "Preferred Provider" / "Network Provider" / "Participating Provider" → `in_*`. "Non-Participating Provider" / "Out-of-Network Provider" → `out_*`.
3. **HMOs with no out-of-network coverage.** Set `out_*` cost fields to `null` and `out_cost_description` to `"Not covered"`.
4. **"No charge" / "$0 copay".** Annotate `in_copay: 0`, `in_coinsurance: 0`, `in_deductible_applies: false`. The parser interprets this combination as fully covered.
5. **Deductible-then-coinsurance.** "No charge after deductible has been met" → `in_copay: null`, `in_coinsurance: null`, `in_deductible_applies: true`, `in_cost_description: "No charge after deductible has been met"`. (The cost AFTER deductible is the plan's general coinsurance, captured at plan level via `in_coinsurance_default`.)
6. **Tier-1 / Tier-2 / Tier-3 / Tier-4 drugs.** One service per tier (`generic_rx_tier1`, `preferred_brand_rx_tier2`, `non_preferred_rx_tier3`, `specialty_rx_tier4`). Repeat for retail vs mail-order via separate entries with different `place_of_service`.
7. **Embedded vs aggregate family deductible.** If `in_deductible_family == 2 × in_deductible_individual`, set `deductible_calc_method: "embedded"`. Otherwise `"aggregate"`. Per-SBC text usually clarifies.

## Validation

Run from repo root:

```bash
node -e "for (const f of require('fs').readdirSync('tests/fixtures/sbcs', {withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name)) try { JSON.parse(require('fs').readFileSync(\`tests/fixtures/sbcs/\${f}/expected.json\`,'utf8')) } catch(e){ console.error(f, e.message) }"
```

Any non-empty output indicates a JSON syntax error in one of the fixtures.
