/**
 * Plan_doc plan-identity Haiku prompt.
 *
 * Extracts plan-level scalars (carrier / plan name / plan year / plan type / metal tier /
 * group number / network type) + in-network and out-of-network deductibles + OOP maxes
 * (individual + family). Pattern P-8 source_excerpt per field for cite-grade dispute
 * letter resolution.
 *
 * S73 (Session 76) — recall lift to ≥90% HARD GATE:
 *   - Explicit instruction that plan-identity scalars may be SCATTERED across
 *     non-plan-identity sections (services schedule, preamble cover page, etc.)
 *   - Few-shot examples covering common variants (Cigna "The Schedule", Kaiser
 *     "Cost Share Summary", Aetna preamble cover, federal SBC template)
 *   - Explicit instruction that NULL is preferred over a wrong guess when a field
 *     is genuinely not present in THIS chunk (field-merge across multi-section
 *     dispatch will recover the value from another chunk)
 */

import type { ExtractionMethod } from "../../parser/types";
import type {
  PlanDocPlanIdentity,
  PlanDocSectionResult,
  PlanDocPatternP8Provenance,
  PlanDocSectionHint,
} from "../types";
import type { PlanDocLayout } from "../layout-detector";
import { loadActiveSupplement } from "../prompt-loader";
import { callHaikuWithCache } from "./_shared";

const PROMPT_FILE_PATH = "src/lib/plan_doc/haiku-prompts/plan-identity.ts";

// Federal-SBC tabular-extraction supplement. Federal SBCs use a tight
// federally-mandated table layout where pdftotext splits cells across
// consecutive lines (e.g., a deductible cell may render as "$2,500 per
// individual / $5,000 per" on one line and "family" on the next). The default
// plan-identity prompt is tuned for narrative + table content found in EOCs
// and plan booklets; SBCs need this explicit guidance to avoid synthesizing
// multi-line cells into excerpts that fail verbatim verification. Mirrors
// src/lib/sbc/haiku-prompts/important-questions.ts:20 verbatim guidance.
const FEDERAL_SBC_TABULAR_SUPPLEMENT = `

## FEDERAL-SBC LAYOUT — TABULAR EXTRACTION OVERRIDE (read carefully)

This document is a federal Summary of Benefits and Coverage (SBC). pdftotext
extracts SBC table cells across MULTIPLE LINES. Example: a deductible answer
cell may render as:

\`\`\`
$2,500 per individual / $5,000 per
family for participating providers;
$5,000 per individual / $10,000 per
family for non-participating providers
\`\`\`

When extracting source_excerpt for plan-identity scalars on an SBC:
- Quote a SINGLE LINE from the source containing the value
  (e.g., "$2,500 per individual / $5,000 per" for the individual deductible).
- DO NOT attempt to reconstruct multi-line cells into one excerpt — that will
  fail verbatim verification.
- Short verbatim single-line quotes are CORRECT; long reconstructed
  paraphrases are WRONG.
- An excerpt of just the value (e.g., "$2,500") is preferred over a wrong
  reconstruction. If the value isn't on its own line, quote the line where it
  appears as part of the surrounding cell content.

This rule supersedes the default tendency to include label-value pairs that
would only "make sense" if joined across lines.`;

// S93 Stage 5a — supplement loads from `parser_prompt_versions` (mig 102) at
// parse time with a 5-min in-process cache. The compile-time const above is
// the fallback when no active DB row exists. Admin tunes via /admin/parse-
// quality-tuning (Stage 5c) which writes a new active row + busts the cache.
async function buildInstructions(layout: PlanDocLayout | undefined): Promise<string> {
  if (layout === "federal_sbc_8page" || layout === "federal_sbc_csr_variant") {
    const supplement = await loadActiveSupplement(
      PROMPT_FILE_PATH,
      "FEDERAL_SBC_TABULAR_SUPPLEMENT",
      FEDERAL_SBC_TABULAR_SUPPLEMENT,
    );
    return BASE_INSTRUCTIONS + supplement;
  }
  return BASE_INSTRUCTIONS;
}

const BASE_INSTRUCTIONS = `You are extracting plan-identity scalars from a section of a health plan document. Plan-identity scalars (plan name, carrier, identifiers, plan year, plan/network type, metal tier, deductibles, out-of-pocket maxes) may appear ANYWHERE in a section — cover pages, plan-summary boxes, services-schedule headers, narrative paragraphs, cost-share tables, and RUNNING HEADERS / FOOTERS that repeat on every page. Extract every scalar present in THIS chunk; the system runs this prompt on multiple sections of the same document and merges results across chunks.

The patterns below are UNIVERSAL — they apply across hundreds of insurance carriers, employer groups, marketplace plans, Medicare Advantage plans, and HMO/PPO/EPO/POS/HDHP variants. Apply the universal extraction logic; do NOT pattern-match against specific carrier names. Brand names in the examples are illustrative.

## SECTION 1 — CRITICAL EXTRACTION RULES

### 1.1 Verbatim source_excerpt per field (≤200 chars)

A CONTIGUOUS substring of THIS chunk's text that appears CHARACTER-FOR-CHARACTER in the source. NEVER paraphrase, summarize, or join non-contiguous pieces. Partial quotes are PERFECTLY ACCEPTABLE — even a short span containing just the value is fine. Quote the most informative contiguous span ≤200 chars you can find verbatim.

**CORRECT** (any of these are acceptable — pick the most informative contiguous verbatim span):
- Just the value: \`"$500"\` or \`"$1,500 individual / $3,000 family"\`
- A full sentence IF it appears verbatim: \`"What is the overall deductible? $500 individual / $1,000 family"\`
- A multi-line span including literal line breaks as they appear in the source: \`"$1,500 individual\\n$3,000 family"\`
- A short label-value pair IF literally adjacent: \`"Deductible: $1,500"\` or \`"Plan Year: 2025"\`
- A repeating identifier from a running header/footer: \`"Group ID: 34936"\` (these are signal, not noise)

**INCORRECT** (paraphrased — would fail verification):
> \`"Individual in-network deductible is $500 with $1,000 family deductible"\` (synthesized wording)

**INCORRECT** (joined non-contiguous pieces — would fail):
> \`"deductible ... $500 individual ... in-network"\` (ellipsis indicates skipped text)

**INCORRECT** (added punctuation / pipes / brackets that aren't in source):
> \`"[In-Network] $500 | $1,000"\` (if source has these values on separate lines without bracket/pipe markup)

If you genuinely cannot find a contiguous verbatim span containing the field's value, set source_excerpt to "". Prefer SHORT but verifiable over LONG but synthesized.

### 1.2 NULL is preferred over guessing

If a scalar is NOT present in this chunk, return value=null + source_excerpt="". Do NOT infer / interpolate / guess from context. The system runs this same prompt on other sections of the document; field-merge across chunks recovers values you don't find here.

### 1.3 Field types

- planName, insurerName, planType, metalTier, groupNumber, networkType: string | null
- planYear: integer | null
- All deductibles + OOP maxes: integer (USD, no commas/symbols) | null

### 1.4 EXPLICIT-ZERO SEMANTIC for cost-sharing fields (HIGH-VALUE UNIVERSAL RULE)

For deductibles and OOP-max fields, when the source EXPLICITLY states there is no cost-sharing requirement, return the integer **0** — NOT null. NULL means "not present in this chunk"; 0 means "the document explicitly states the cost-sharing value is zero."

**Explicit-zero indicators** (universal across carriers — return integer 0):
- \`"None"\` (e.g., "Plan Deductible: None", "Drug Deductible: None") — common in HMO and $0-deductible plans
- \`"No deductible"\` / \`"No annual deductible"\` / \`"No medical deductible"\`
- \`"$0"\` / \`"$0.00"\` / \`"0"\` (the digit alone in a cost-share cell)
- \`"Zero"\` / \`"Zero deductible"\`
- \`"Waived"\` — when this is the WHOLE value in a deductible/OOPM cost-share cell with NO conditional qualifier (no "for ___", "when ___", "if ___", "subject to ___"). A bare "Waived" is a definitive cost-share waiver.

### 1.4.1 CONDITIONAL WAIVERS — preserve as useful user context (value=null, source_excerpt populated)

When a deductible/OOPM cell shows a conditional waiver (a "Waived" / "$0" / "No charge" qualified by a condition), the parser CANNOT reduce it to a single number — but the conditional phrase is **highly valuable user-facing context** that should NOT be discarded.

**Rule**: return value=null AND populate source_excerpt with the verbatim conditional phrase. The Pattern P-8 verifier will verify the excerpt, and downstream consumers can render the conditional context as a citation-grade note.

Universal conditional-waiver patterns:
- \`"Waived for emergencies"\` / \`"Waived for emergency services"\`
- \`"Waived for preventive care"\` / \`"Waived for preventive services"\`
- \`"Waived when [individual / family] deductible met"\`
- \`"Waived if ___"\` / \`"Waived when ___"\` / \`"Waived after ___"\`
- \`"Subject to ___ deductible"\` / \`"Subject to coinsurance"\`
- \`"$0 after deductible"\` / \`"No charge after deductible"\` — qualified by a precondition
- \`"Does not apply to [category]"\` / \`"Does not apply when ___"\`

Examples (extract verbatim source_excerpt for context surfacing):
- Source: \`"Annual Deductible: Waived for emergency services"\` → value=null, source_excerpt="Annual Deductible: Waived for emergency services"
- Source: \`"Family Deductible: Waived when individual deductible met"\` → value=null, source_excerpt="Family Deductible: Waived when individual deductible met"
- Source: \`"Specialist Visit: $0 after deductible"\` → value=null, source_excerpt="Specialist Visit: $0 after deductible"

### 1.4.2 AMBIGUOUS INDICATORS — return null (false-positive risk too high)

These phrases CANNOT be safely mapped to $0 because they are routinely used to mean BOTH "$0 cost-share" AND "this concept doesn't apply to this plan." Misreading "concept doesn't apply" as "$0" creates user-facing misinformation (e.g., showing "$0 OON deductible" when reality is "no OON coverage at all").

Return **null** for all of these:
- \`"N/A"\` / \`"n/a"\` / \`"N.A."\` — high ambiguity; could mean concept-doesn't-apply
- \`"Not applicable"\` / \`"Not Applicable"\` / \`"not applicable"\` — same ambiguity
- \`"Does not apply"\` — same ambiguity as N/A; could mean "concept doesn't apply to this plan" (e.g., "Out-of-Network: Does not apply" for an HMO) OR "value is zero". Too risky to auto-zero.
- \`"Not Covered"\` / \`"Not covered"\` — clearly means concept doesn't apply for this plan (NOT $0)

### 1.4.3 Always null (no information)

- Blank cell / \`"-"\` / \`"—"\` / \`"..."\`
- A sentence describing CONCEPT EXCLUSION at the section level: \`"We do not cover X"\` / \`"Out-of-Network coverage: Not applicable for this plan"\` / \`"Out-of-network benefits are not provided"\` — these say the concept does not apply to this plan; do not assume $0.

### Verbatim quote summary for explicit-zero AND conditional context

Quote exactly as in source — partial or full, whichever is shorter but verifiable:
- Source: \`"Plan Deductible: None"\` → value=0, source_excerpt="Plan Deductible: None"
- Source: \`"Deductible (Individual): $0"\` → value=0, source_excerpt="Deductible (Individual): $0"
- Source: \`"Annual Deductible: Waived"\` → value=0, source_excerpt="Annual Deductible: Waived"
- Source: \`"Deductible: Waived for emergencies"\` → value=null, source_excerpt="Deductible: Waived for emergencies" (conditional context preserved)
- Source: \`"Deductible: N/A"\` → value=null, source_excerpt="" (ambiguous; do not preserve a misleading partial quote)
- Source: \`"OON Deductible: Does not apply"\` → value=null, source_excerpt="" (concept-doesn't-apply, not $0)
- Source: \`"Out-of-Network Deductible: Not Covered"\` → value=null, source_excerpt="" (concept exclusion at section level)

### 1.5 OON values: MANDATORY when document has OON columns; null for in-network-only docs

- If the document includes any out-of-network columns / rows / paragraphs with OON values, extract them.
- If the document is HMO-only / EPO-only and has no OON coverage at all, set out_* fields to null. DO NOT default OON to in-network values. DO NOT fabricate OON values when none are stated.

### 1.6 Multi-section dispatch behavior (be additive, not exhaustive in one call)

The system calls this same prompt on multiple sections of one document and merges chunk results. For any field you can't find in THIS chunk, return null. A later chunk may contain it. NEVER copy a value from one field into another (e.g., do not copy planType into networkType just because both are blank — that creates false signal).

### 1.7 EXTERNAL-REFERENCE RULE — return null when the document points to an external source

Many documents explicitly reference an external source for a value rather than stating it inline. When this is the case, return value=null + source_excerpt="" for that field. Do NOT extract the reference phrase as the value.

Universal external-reference phrases (case-insensitive — look for these patterns):
- \`"shown on your ID card"\` / \`"see your member ID card"\` / \`"refer to your ID card"\` / \`"on the back of your member ID card"\`
- \`"see the Schedule of Cost Sharing"\` / \`"refer to the Schedule"\` / \`"shown in the Schedule"\`
- \`"see the Summary of Benefits"\` / \`"refer to the Summary"\` / \`"shown in the SBC"\`
- \`"see your plan documents"\` / \`"refer to your contract"\` / \`"shown in your Evidence of Coverage"\`
- \`"call Member Services for [the value]"\` / \`"contact us for your group number"\`
- \`"see www.[carrier].com for [the value]"\` / \`"visit our website for amounts"\`

Examples:
- Source: \`"YOUR ACCOUNT/GROUP NUMBER IS SHOWN ON your ID card"\` → groupNumber: value=null, source_excerpt=""
- Source: \`"Your deductible is shown in the Schedule of Cost Sharing"\` → deductibleIndividual: value=null, source_excerpt=""
- Source: \`"Refer to your member ID card for your plan code"\` → groupNumber: value=null, source_excerpt=""

**Distinguish from conditional context (§1.4.1)**: a conditional waiver phrase like \`"Deductible: Waived for emergencies"\` IS the value-relevant content (preserve as source_excerpt + null value). An external-reference phrase like \`"Deductible is shown elsewhere"\` is NOT value-relevant (return null + empty source_excerpt).

## SECTION 2 — FIELD-BY-FIELD UNIVERSAL EXTRACTION PATTERNS

### 2.1 planName (string | null)

The plan's marketed name — what a member would call this plan. NOT the document type, NOT the section label.

Universal recognition patterns:
- Prefixed by \`"Plan:"\`, \`"Plan Name:"\`, \`"This plan,"\`, \`"Our plan,"\`
- Document title on cover page (e.g., \`"Aetna Medicare Plan (PPO)"\`, \`"Silver 70 PPO 2025"\`)
- Often combines carrier + product line + metal/network suffix (e.g., \`"Cigna Open Access Plus"\`, \`"BCBS Federal Standard Option"\`, \`"Kaiser Permanente Traditional HMO Plan"\`)
- Marketplace plans often include the metal tier in the plan name (e.g., \`"Silver 70 HMO"\`, \`"Bronze 60 HDHP"\`)

**Avoid extracting** (these are document types / section labels, not plan names):
- \`"Evidence of Coverage"\` / \`"EOC"\` — a document type
- \`"Summary of Benefits and Coverage"\` / \`"SBC"\` — a document type
- \`"Plan Benefits Booklet"\` / \`"Benefits Summary"\` / \`"Schedule of Cost Sharing"\` — document sections or types
- \`"Member Handbook"\` / \`"Subscriber Agreement"\` — document types

### 2.2 insurerName (string | null)

The carrier / insurance company. Universal patterns:
- Standalone brand on cover (e.g., \`"Aetna"\`, \`"Kaiser Permanente"\`, \`"Cigna"\`, \`"Anthem Blue Cross"\`, \`"UnitedHealthcare"\`, \`"Humana"\`)
- Legal entity name (extract the carrier brand): \`"Kaiser Foundation Health Plan, Inc."\` → \`"Kaiser Permanente"\` or \`"Kaiser"\`; \`"Aetna Life Insurance Company"\` → \`"Aetna"\`
- When plan name embeds the carrier (e.g., \`"Cigna Open Access Plus"\`), extract just the carrier: insurerName=\`"Cigna"\`

**Common confusion — POLICYHOLDER ≠ insurerName**:
Some plans show a \`"POLICYHOLDER:"\`, \`"Plan Sponsor:"\`, \`"Plan Administrator:"\`, or \`"Group:"\` label naming the EMPLOYER, PEO, union, or trust (e.g., \`"POLICYHOLDER: Sequoia One PEO, LLC"\`, \`"Plan Sponsor: Acme Corp Employee Benefit Trust"\`, \`"GROUP: ABC Manufacturing Inc."\`). This is the employer / group sponsor, NOT the insurance carrier. Do NOT extract POLICYHOLDER / Plan Sponsor / Plan Administrator as insurerName.

The carrier (insurerName) is typically named on the cover or in legal entity disclosure adjacent to phrases like \`"is offered by"\`, \`"issued by"\`, \`"administered by"\`, \`"underwritten by"\` (e.g., \`"Cigna Health and Life Insurance Company"\`, \`"Aetna Life Insurance Company"\`, \`"Blue Shield of California"\`, \`"Kaiser Foundation Health Plan, Inc."\`).

### 2.3 planType (string | null) — RESTRICTED VOCABULARY

Acceptable values only: \`"PPO"\` | \`"HMO"\` | \`"EPO"\` | \`"POS"\` | \`"HDHP"\` | \`"Other"\` (null if truly not specified)

Universal recognition patterns:
- Abbreviation in plan name or section: \`"PPO"\`, \`"HMO"\`, \`"EPO"\`, \`"POS"\`, \`"HDHP"\`
- Full name → abbreviation mapping:
  - \`"Preferred Provider Organization"\` → \`"PPO"\`
  - \`"Health Maintenance Organization"\` → \`"HMO"\`
  - \`"Exclusive Provider Organization"\` → \`"EPO"\`
  - \`"Point of Service"\` → \`"POS"\`
  - \`"High Deductible Health Plan"\` → \`"HDHP"\`
- Medicare Advantage variants: \`"Medicare Advantage PPO"\` → \`"PPO"\`; \`"Medicare Advantage HMO"\` → \`"HMO"\`
- Suffix indicator: plan name ending in \`"PPO"\` / \`"HMO"\` / \`"EPO"\` etc. (e.g., \`"Silver 70 PPO"\` → \`"PPO"\`)
- HSA qualifier hint: \`"HSA-qualified"\` / \`"HSA-compatible"\` strongly suggests HDHP (confirm with explicit "HDHP" or "High Deductible" in source)

**Carrier-specific planType abbreviations** (universal — map to closest standard):
Some carriers use 3-4 letter abbreviations specific to their network products. Map these to the closest standard planType vocabulary AND capture the carrier-specific label as networkType simultaneously:
- \`"OAP"\` (Cigna Open Access Plus) → planType=\`"PPO"\` + networkType=\`"Open Access Plus"\`
- \`"POS II"\` (Aetna Choice POS II) → planType=\`"POS"\` + networkType=\`"POS II"\` or \`"Choice POS II"\`
- Brand-named networks (\`"Choice Plus"\` UnitedHealthcare, \`"LocalPlus"\` Cigna, \`"Blue Choice"\` Anthem, \`"Pathway"\` Anthem, \`"Navigate"\` UnitedHealthcare) — most named open-access networks are PPO variants → planType=\`"PPO"\` + networkType=brand name
- When the carrier-specific name is the ONLY plan-type signal (no expanded full name in chunk), infer from network-access language: \`"open access"\` / \`"no referral required"\` → PPO; \`"primary care physician required"\` / \`"PCP referral"\` / \`"gatekeeper"\` → HMO; \`"in-network only, no out-of-network coverage"\` → EPO or HMO
- When in doubt and no clear signal exists, set planType to null in this chunk; field-merge may recover it from another section.

### 2.4 metalTier (string | null) — RESTRICTED VOCABULARY; marketplace plans only

Acceptable values only: \`"Bronze"\` | \`"Silver"\` | \`"Gold"\` | \`"Platinum"\` | \`"Catastrophic"\` (null if not specified)

Universal patterns:
- Standalone: \`"Silver Plan"\`, \`"Gold Plan"\`, \`"Bronze"\`, \`"Platinum"\`, \`"Catastrophic"\`
- In plan name: \`"Silver 70 PPO"\` → \`"Silver"\`; \`"Bronze HDHP"\` → \`"Bronze"\`; \`"Gold 80 HMO"\` → \`"Gold"\`
- The numeric suffix (60/70/80/90) is the actuarial value — extract the tier name only

**Return null** (metal tier does not apply):
- Medicare plans (Medicare uses CMS contract types, not metal tiers)
- Employer-sponsored / ERISA / Federal Employee plans
- Self-funded employer plans

### 2.5 planYear (integer | null)

Universal patterns:
- Explicit labels: \`"Plan Year: 2025"\`, \`"Plan Year 2025"\`, \`"2025 Plan Year"\`
- Coverage period dates: \`"Coverage Period: 1/1/2025 - 12/31/2025"\`, \`"January 1, 2025 through December 31, 2025"\`, \`"January 1 – December 31, 2025"\`, \`"Effective: 1/1/2025 - 12/31/2025"\`
- Document title prefix: \`"2025 Evidence of Coverage"\`, \`"2025 Summary of Benefits"\`
- Often appears on cover page or in running document header

When multiple dates appear (effective date, issue date, expiration date), prefer the year of the COVERAGE PERIOD.
If the document is a mid-year amendment (e.g., effective July 1, 2025), planYear is still 2025 — extract the calendar year covered, not the amendment's start date.

**Effective date alone ≠ plan year**: When a doc shows only \`"EFFECTIVE DATE: July 1, 2024"\` or \`"Effective: 1/1/2025"\` WITHOUT an explicit plan year label OR a coverage-period end-date, the planYear is the calendar year that contains the effective date (here, 2024 or 2025 respectively) — UNLESS the doc explicitly states a different plan year (e.g., \`"Plan Year: 2024-2025"\` → planYear=2024 for the start year, or planYear=2025 for the calendar year MOST of the coverage spans; prefer the start year for the field, since plan-year scalars are typically the start year). When BOTH an effective date AND a coverage period are present in the same chunk, prefer the coverage period's year.

Example:
- Source: \`"EFFECTIVE DATE: July 1, 2024"\` (no coverage-period end) → planYear=2024, source_excerpt="EFFECTIVE DATE: July 1, 2024"
- Source: \`"Effective: 1/1/2025 - 12/31/2025"\` → planYear=2025
- Source: \`"Coverage Period: 01/01/2026 - 12/31/2026"\` → planYear=2026

### 2.6 groupNumber (string | null) — UNIVERSAL IDENTIFIER PATTERNS

The employer group identifier OR carrier contract number. **High-value field that is often missed because it appears in running headers/footers** rather than in narrative body text.

Universal label patterns (case-insensitive):
- \`"Group ID:"\` / \`"Group ID #"\` / \`"Group I.D.:"\`
- \`"Group Number:"\` / \`"Group #:"\` / \`"Group:"\` (when followed by an identifier)
- \`"Group Contract Number:"\` / \`"Group Contract:"\`
- \`"Contract:"\` / \`"Contract ID:"\` / \`"Contract Number:"\` / \`"Contract #:"\` (especially in Medicare contracts and Medicare Advantage plans)
- \`"Policy Number:"\` / \`"Policy #:"\` / \`"Policy ID:"\`
- \`"Subscriber Group:"\` / \`"Member Group ID:"\` / \`"Employer Group:"\`

Universal value patterns:
- Format: alphanumeric, typically 4-12 characters (e.g., \`"34936"\`, \`"G-12345"\`, \`"H1234"\`, \`"GRP0042"\`, \`"22107"\`)
- May include hyphens, slashes, or letter prefixes
- Often paired with adjacent fields: \`"Group ID: 34936 Contract: 1 Version: 102"\` (extract just the group ID value: \`"34936"\`)

**Running-header signal**: when a string like \`"Group ID: 34936"\` or \`"Group ID: 34936 [Plan Name]"\` appears multiple times in a chunk (e.g., as repeated page-footer markers), it is HIGHLY RELIABLE — treat it as authoritative. The repetition is signal, not noise.

If the chunk shows \`"Group ID: 34936"\` and \`"Contract: 1"\` adjacently, extract groupNumber=\`"34936"\` (the Group ID is the group/employer identifier; Contract is a separate carrier-internal sequence).

**Counter-examples — DO NOT extract these as groupNumber** (universal — return null):
Bare alphanumeric strings on cover pages WITHOUT an explicit Group/Policy/Contract/Account label are typically regulatory filing codes, federal form numbers, or carrier internal product codes — NOT member-facing group numbers. Universal patterns to ignore:
- **CMS / federal filing codes**: \`"Y0001_D2_EOC25_C"\`, \`"H1234_25EOC_C"\`, \`"S5601_EOC_2025"\` — Medicare contract IDs CAN be member-facing (H#### / Y#### / S####) but only when explicitly labeled (\`"Contract:"\` / \`"Plan ID:"\`). Bare strings on a cover page without a label are filing codes.
- **Federal form numbers**: \`"OMB Approval 0938-1051"\`, \`"OMB No. 1820-0664"\` — government form numbers, not group IDs
- **Carrier internal product codes**: \`"GRP_EOC_2025_D2_AE_ESA_MAPD"\`, \`"CN011"\`, \`"2501764"\`, \`"BSC-EOC-Silver-70-2025"\` — internal product / version identifiers
- **Document version codes**: \`"Rev. 06/2024"\`, \`"Form: BSC-EOC-2025"\`, \`"v3.1"\`
- **HIOS plan IDs** in marketplace plans (e.g., \`"96240CA0080001-01"\`) — public-marketplace identifiers, not member-facing group numbers

**Rule**: only extract as groupNumber when a recognizable label (Group ID/Number/#, Policy Number, Contract Number, Account Number, Subscriber Group, Member Group ID, Employer Group) is adjacent (within ~30 chars) to the value. If the alphanumeric string stands alone on a line with no label, return null and let other extractors (or field-merge from another section) pick it up if appropriate.

### 2.7 networkType (string | null) — granular network label, distinct from planType

A network's marketed name, finer-grained than planType. Universal patterns:
- Cigna: \`"Open Access Plus"\`, \`"OAP"\`, \`"LocalPlus"\`
- Anthem / BCBS: \`"PPO Network"\`, \`"Blue Choice"\`, \`"Pathway"\`, \`"Blue Card"\`, \`"Federal Standard Option"\`
- Aetna: \`"Choice POS II"\`, \`"Aetna Whole Health"\`, \`"Open Choice"\`
- UnitedHealthcare: \`"Choice Plus"\`, \`"Navigate"\`, \`"Select Plus"\`
- Kaiser: \`"Traditional HMO"\`, \`"Signature HMO"\`, \`"Deductible HMO"\`
- Tiered networks: \`"Tier 1 / Tier 2"\`, \`"Preferred Network"\` vs \`"Standard Network"\`
- HMO subtypes: \`"Direct Access HMO"\`, \`"Gated HMO"\`, \`"Open Access HMO"\`

If the document only references the broad type (e.g., just says \`"PPO"\` with no granular network label), return null for networkType (don't duplicate planType).

If the network type embeds the plan type (e.g., \`"Traditional HMO"\`), extract the full granular label for networkType (\`"Traditional HMO"\`) AND the abbreviation for planType (\`"HMO"\`).

### 2.8 Deductible + OOP-max recognition (USD integer or null)

**Field naming variations** (all universal across carriers):
- Deductibles: \`"Deductible"\`, \`"Annual Deductible"\`, \`"Calendar Year Deductible"\`, \`"Plan Deductible"\`, \`"Medical Deductible"\`, \`"In-Network Deductible"\`
- OOP-max: \`"Out-of-Pocket Maximum"\`, \`"OOP Max"\`, \`"OOPM"\`, \`"Plan OOPM"\`, \`"Annual Limit"\`, \`"Plan Maximum"\`, \`"Annual Out-of-Pocket Maximum"\`, \`"Maximum Out-of-Pocket"\`, \`"Combined Maximum Out-of-Pocket"\`, \`"MOOP"\` (Medicare term)

**Individual terminology** (all mean Individual — extract to *Individual):
\`"Individual"\`, \`"Self-Only"\`, \`"Single"\`, \`"Single Coverage"\`, \`"Member"\`, \`"Per Member"\`, \`"Per Person"\`, \`"One-Party"\`, \`"Each Member in Family"\` (per-member amount when on a family plan), \`"Per Individual"\`, \`"Self"\`

**Family terminology** (all mean Family — extract to *Family):
\`"Family"\`, \`"Family Coverage"\`, \`"Two-Party or More"\`, \`"Family Aggregate"\`, \`"Entire Family"\`, \`"Family of Two or More Members"\`, \`"All Members"\`, \`"Total Family"\`, \`"Family Total"\`, \`"Maximum Family"\`

**Three-column table pattern** (common in HMO + employer plans — extract correctly):
When a cost-share table shows three columns:
- Column A: Self-Only / Single
- Column B: Each Member in Family / Per Member on Family Plan
- Column C: Entire Family / Family of Two or More

→ Columns A AND B both map to deductibleIndividual / oopMaxIndividual (they're both individual-level — the same per-person amount whether on single or family coverage)
→ Column C maps to deductibleFamily / oopMaxFamily (the family-aggregate amount)

**Two-column table pattern** (most common):
- Column A: Individual / Self-Only / Single
- Column B: Family

→ A=Individual, B=Family. Straightforward.

**Inline-text pattern**:
- \`"$1,500 individual / $3,000 family"\` → Individual=1500, Family=3000
- \`"$500 per person, $1,000 per family"\` → Individual=500, Family=1000

### 2.9 OON vs in-network identification (universal)

**In-network signals** (extract to deductibleIndividual / oopMaxIndividual etc.):
- \`"In-Network"\`, \`"Network"\`, \`"In-Plan"\`, \`"Participating"\`, \`"Preferred Provider"\`, \`"Preferred"\`, \`"Tier 1"\`, \`"Plan Provider"\`

**Out-of-network signals** (extract to outDeductibleIndividual / outOopMaxIndividual etc.):
- \`"Out-of-Network"\`, \`"Non-Network"\`, \`"Out-of-Plan"\`, \`"Non-Participating"\`, \`"Non-Preferred"\`, \`"OON"\`, \`"Tier 2"\`, \`"Tier 3"\`, \`"Non-Plan Provider"\`

**HMO-only document patterns** (set out_* to null):
- Document explicitly states \`"no out-of-network coverage"\` or \`"benefits are not available out-of-network"\`
- Document is labeled HMO/EPO and has no OON columns
- Document mentions OON only as an exception for emergencies (still set out_* to null — emergency-OON cost-sharing is a separate concept from regular OON)

### 2.10.5 ACA compliance — isAcaCompliant (boolean | null) + acaComplianceBasis (enum | null)

**What we need**: a flag indicating whether this plan is governed by Affordable Care Act preventive-care mandates (covers ACIP vaccines + USPSTF Grade A/B preventive services at $0 patient cost-share in-network). Downstream audit pipeline uses this flag to gate ACA-preventive coverage fallback per service.

**Output two paired fields**:
- \`isAcaCompliant\`: \`true\` | \`false\` | \`null\`
- \`acaComplianceBasis\`: one of \`"explicit_attestation"\` | \`"inferred_marketplace"\` | \`"inferred_employer_post_2010"\` | \`"explicit_grandfathered"\` | \`"unknown"\` | \`null\`

**Signal patterns (universal across carriers — apply in priority order)**:

1. **Explicit attestation** → \`isAcaCompliant=true, acaComplianceBasis="explicit_attestation"\`. Phrases:
   - \`"This plan is ACA-compliant"\` / \`"complies with the Affordable Care Act"\`
   - \`"meets ACA minimum essential coverage"\` / \`"qualifies as minimum essential coverage (MEC) under the ACA"\`
   - \`"covers preventive services at no cost-sharing per the Affordable Care Act"\`
   - \`"provides essential health benefits (EHB) as defined by the ACA"\`
   - \`"complies with all federal health care reform requirements"\` (post-2010 employer-plan language; ACA proxy)

2. **Explicit grandfathered** → \`isAcaCompliant=false, acaComplianceBasis="explicit_grandfathered"\`. Phrases:
   - \`"This is a grandfathered plan"\` / \`"grandfathered under the Affordable Care Act"\` / \`"grandfathered under the ACA"\`
   - \`"This plan is exempt from certain ACA provisions because it is a grandfathered health plan"\`

3. **Inferred marketplace** → \`isAcaCompliant=true, acaComplianceBasis="inferred_marketplace"\`. Triggers:
   - Doc mentions purchase via \`"Covered California"\`, \`"healthcare.gov"\`, \`"state health insurance exchange"\`, \`"federal marketplace"\`, \`"individual marketplace plan"\`, \`"on-exchange"\` — all marketplace plans are ACA-compliant by definition.

4. **Inferred employer post-2010** → \`isAcaCompliant=true, acaComplianceBasis="inferred_employer_post_2010"\`. Triggers (BOTH must be present):
   - The doc indicates an employer-sponsored plan (POLICYHOLDER, Plan Sponsor, Group Number, Employer Group ID, etc.) AND
   - Either an effective date ≥ 2011 OR plan year ≥ 2011 is present in the chunk, AND
   - NO grandfathered language anywhere in the chunk.

5. **Unknown** → \`isAcaCompliant=null, acaComplianceBasis="unknown"\`. When THIS chunk has none of the above signals. The system will default isAcaCompliant=true (basis=unknown) at the persistence layer for plans where no chunk found explicit text — do NOT emit a TRUE guess from this prompt without a basis match above.

**Important — null vs unknown semantics**:
- If you can't find any ACA signal in this chunk, return \`isAcaCompliant=null\` + \`acaComplianceBasis=null\` (let field-merge from other chunks supply the answer, or persistence default fires).
- Only emit \`acaComplianceBasis="unknown"\` when the chunk EXPLICITLY indicates uncertainty (rare — e.g., "Please consult your benefits administrator regarding ACA compliance status.").

**Pattern P-8 source_excerpt**: when isAcaCompliant is non-null, source_excerpt must be a verbatim ≤200-char span supporting the basis. For \`inferred_*\` bases, the excerpt can be the marketplace/employer/year evidence (e.g., \`"Group ID: 34936"\` + \`"Plan Year: 2025"\` — quote whichever single span best supports the inference).

**Examples**:
- Source: \`"This plan is ACA-compliant and provides minimum essential coverage."\` → isAcaCompliant=true, acaComplianceBasis="explicit_attestation", source_excerpt="This plan is ACA-compliant and provides minimum essential coverage."
- Source: \`"This is a grandfathered health plan under the Affordable Care Act."\` → isAcaCompliant=false, acaComplianceBasis="explicit_grandfathered", source_excerpt="This is a grandfathered health plan under the Affordable Care Act."
- Source: \`"Purchased through Covered California"\` → isAcaCompliant=true, acaComplianceBasis="inferred_marketplace", source_excerpt="Purchased through Covered California"
- Source: \`"Plan Year: 2025 ... Group ID: 34936 Sequoia One PEO, LLC"\` (no grandfathered language, employer plan + post-2010) → isAcaCompliant=true, acaComplianceBasis="inferred_employer_post_2010", source_excerpt="Plan Year: 2025" (or "Group ID: 34936")
- Source chunk with NO ACA signal of any kind → isAcaCompliant=null, acaComplianceBasis=null, source_excerpt=""

### 2.10 Common extraction pitfalls (universal — avoid these)

- **Document type as plan name**: Extracting \`"Evidence of Coverage"\` or \`"Summary of Benefits"\` as the plan name. These are document types; the plan name is the marketed product (e.g., \`"Silver 70 PPO"\`).
- **Section header as a field value**: Extracting \`"Deductibles and Out-of-Pocket Maximums"\` (a section header) as a value for the deductible field. Section headers are descriptive, not the value itself.
- **Hypothetical examples as actual values**: Source text may include teaching examples (\`"For example, if your deductible is $500..."\`) — these are illustrative, NOT the actual plan's deductible. Only extract values stated as the plan's actual cost-sharing.
- **Combined value as individual**: \`"Combined Maximum Out-of-Pocket: $7,500"\` is typically a combined in+out total, NOT the in-network individual amount. Set to null unless the source explicitly states it's the in-network individual OOPM.
- **Drug deductible confused with medical deductible**: \`"Drug Deductible: $250"\` is a separate Part D / pharmacy deductible — do NOT use as the medical deductibleIndividual. The medical deductible is usually labeled \`"Plan Deductible"\` / \`"Medical Deductible"\` / \`"Annual Deductible"\` without a drug qualifier.
- **Tier-based out-of-network as in-network**: Some PPOs have Tier-1 (preferred network) + Tier-2 (broader network) + Tier-3 (non-participating). Tier-1 is in-network, Tier-3 is out-of-network. If a plan uses tiered network terminology, map Tier-1 → in-network and the lowest preferred-status tier → out-of-network. Don't conflate.
- **Per-service copay as deductible**: Per-service copay rows (e.g., \`"PCP Visit: $20"\`) are copays, NOT the plan-level deductible. Only extract the explicit plan-level deductible row.
- **"Coverage for:" enrollment options ≠ deductible tiers**: Some SBCs include a header line \`"Coverage for: Individual / Individual + Family"\` or \`"Coverage Type: Self-Only / Family"\` or \`"Tier: Employee Only / Employee + Spouse / Family"\`. This describes the ENROLLMENT TIERS available to the member, NOT the deductible split. Do NOT extract these slash-separated tier names as deductibleIndividual / deductibleFamily values. The actual deductible amounts are in the cost-share table elsewhere with explicit dollar figures.
- **External-reference phrases ≠ values** (see §1.7): Sentences like \`"Your group number is shown on your ID card"\` or \`"Refer to the Schedule of Cost Sharing for amounts"\` or \`"Call Member Services for your specific deductible"\` are pointers to external sources. Return null for the referenced field — do NOT extract the reference phrase as a value.
- **POLICYHOLDER / Plan Sponsor as carrier name** (see §2.2): \`"POLICYHOLDER: Acme Corp"\` is the employer, NOT the carrier. The carrier is named separately (e.g., \`"is offered by Cigna"\`, \`"underwritten by Aetna"\`).

## SECTION 3 — FEW-SHOT EXAMPLES (universal patterns; brand names illustrative only)

**Example A — HMO with $0 deductible (universal pattern: explicit "None" → 0)**
Source:
\`\`\`
Group ID: 34936 Kaiser Permanente Traditional HMO Plan

Plan Deductible
                          Self-Only        Each Member in Family        Entire Family
                          None             None                         None

Plan Out-of-Pocket Maximum (OOPM)
                          Self-Only        Each Member in Family        Entire Family
                          $1,500           $1,500                       $3,000
\`\`\`

Extract:
- planName: \`"Kaiser Permanente Traditional HMO Plan"\`
- insurerName: \`"Kaiser Permanente"\`
- planType: \`"HMO"\` (source quote: \`"Traditional HMO Plan"\`)
- networkType: \`"Traditional HMO"\`
- groupNumber: \`"34936"\` (source quote: \`"Group ID: 34936"\`)
- deductibleIndividual: 0 (source quote: \`"Plan Deductible\\n                          Self-Only        Each Member in Family        Entire Family\\n                          None             None                         None"\` — or a shorter span: \`"Plan Deductible"\` adjacent to \`"None"\`)
- deductibleFamily: 0 (same source row — Entire Family column is also "None")
- oopMaxIndividual: 1500 (source quote: \`"Self-Only        Each Member in Family        Entire Family\\n                          $1,500           $1,500                       $3,000"\`)
- oopMaxFamily: 3000 (same row)
- outDeductibleIndividual/Family: null (no OON in HMO doc)
- outOopMaxIndividual/Family: null
- metalTier: null (employer plan, not marketplace)
- planYear: null (not in this chunk)

**Example B — PPO with explicit in + out columns (universal two-column pattern)**
Source:
\`\`\`
                                  In-Network    Out-of-Network
Annual Deductible (Individual)    $1,500        $3,000
Annual Deductible (Family)        $3,000        $6,000
Out-of-Pocket Maximum (Indiv)     $7,000        $14,000
Out-of-Pocket Maximum (Family)    $14,000       $28,000
\`\`\`

Extract:
- deductibleIndividual: 1500, deductibleFamily: 3000
- outDeductibleIndividual: 3000, outDeductibleFamily: 6000
- oopMaxIndividual: 7000, oopMaxFamily: 14000
- outOopMaxIndividual: 14000, outOopMaxFamily: 28000

**Example C — Federal SBC "Important Questions" template (universal inline pattern)**
Source:
> "What is the overall deductible? $500 individual / $1,000 family for in-network providers; $1,500 individual / $3,000 family out-of-network. What is the out-of-pocket limit for this plan? $5,000 individual / $10,000 family in-network."

Extract:
- deductibleIndividual: 500, deductibleFamily: 1000
- outDeductibleIndividual: 1500, outDeductibleFamily: 3000
- oopMaxIndividual: 5000, oopMaxFamily: 10000
- outOopMaxIndividual/Family: null (out-of-network OOPM not stated in this excerpt)

**Example D — Marketplace plan with metal tier and granular networkType**
Source:
> "Silver 70 PPO 2025 — Blue Shield of California — Plan Year: 2025"

Extract:
- planName: \`"Silver 70 PPO"\`
- insurerName: \`"Blue Shield of California"\`
- planType: \`"PPO"\`
- metalTier: \`"Silver"\`
- planYear: 2025
- networkType: null (the document only says PPO, no granular network name)

**Example E — Carrier OAP plan with networkType DISTINCT from planType**
Source:
> "Cigna Open Access Plus Plan ... Group Number: G-87654 ... Plan Year: 2025 ... Open Access Plus is a Preferred Provider Organization (PPO) network."

Extract:
- planName: \`"Cigna Open Access Plus"\`
- insurerName: \`"Cigna"\`
- planType: \`"PPO"\` (mapped from "Preferred Provider Organization (PPO)")
- networkType: \`"Open Access Plus"\`
- groupNumber: \`"G-87654"\`
- planYear: 2025
- metalTier: null (employer plan)

**Example F — Medicare Advantage PPO (no metal tier, individual-only)**
Source:
> "This plan, Aetna Medicare Plan (PPO), is offered by Aetna Medicare. ... January 1 – December 31, 2025"

Extract:
- planName: \`"Aetna Medicare Plan (PPO)"\`
- insurerName: \`"Aetna"\`
- planType: \`"PPO"\`
- planYear: 2025
- metalTier: null (Medicare plans have no metal tier)
- (Other fields null if not in this chunk)

**Example G — Employer HDHP / HSA-compatible**
Source:
> "BCBS Federal Employee Program — High Deductible Health Plan (HDHP) — HSA Qualified — 2025"

Extract:
- planName: \`"BCBS Federal Employee Program HDHP"\` (or as it appears verbatim)
- insurerName: \`"BCBS"\` (or \`"Blue Cross Blue Shield"\` if explicitly stated)
- planType: \`"HDHP"\`
- planYear: 2025

**Example H — Repeating running-header pattern (universal identifier signal)**
Source (notice the same Group ID string appears twice — once on cover, once as page-footer):
\`\`\`
Group ID: 22107 Cigna Open Access Plus Plan

[... body text ...]

Group ID: 22107 Cigna Open Access Plus Plan
Contract: 1   Version: 4   Page 17
\`\`\`

Extract:
- groupNumber: \`"22107"\` (source quote: \`"Group ID: 22107"\` — the repetition confirms authority; pick any one occurrence to quote)
- planName: \`"Cigna Open Access Plus Plan"\` (or \`"Cigna Open Access Plus"\`)
- insurerName: \`"Cigna"\`

**Example I — In-network-only HMO with explicit-zero deductible AND non-zero OOPM**
Source:
\`\`\`
Calendar Year Plan Deductible: $0 individual / $0 family
Calendar Year Out-of-Pocket Maximum: $3,000 individual / $6,000 family
\`\`\`

Extract:
- deductibleIndividual: 0 (source quote: \`"Calendar Year Plan Deductible: $0 individual / $0 family"\`)
- deductibleFamily: 0
- oopMaxIndividual: 3000
- oopMaxFamily: 6000
- outDeductibleIndividual/Family: null (HMO; no OON)
- outOopMaxIndividual/Family: null

**Example J — Counter-example: Hypothetical / teaching example should NOT be extracted**
Source:
> "For example, if your deductible is $500 and you have a $200 claim, you would pay the full $200 ... Refer to the Schedule of Cost Sharing for your actual deductible amount."

Extract:
- deductibleIndividual: null (the $500 in the source is a hypothetical example for teaching the deductible concept, NOT the actual plan's deductible)
- Field-merge across other sections may surface the actual value

**Example K — Counter-example: Combined OOPM should NOT be split into individual/family**
Source:
> "Your combined maximum out-of-pocket for the plan year is $7,500 across all members of your family."

Extract:
- oopMaxFamily: 7500 (this is a family-total combined max — extract as family)
- oopMaxIndividual: null (no individual-level OOPM stated; do NOT use the combined total as the individual amount)

## SECTION 4 — RESPONSE SCHEMA

{
  "planName": { "value": "Cigna OAP Plan 2026", "source_excerpt": "verbatim ≤200 chars from doc", "haiku_confidence": 0.95 },
  "insurerName": { "value": "Cigna", "source_excerpt": "...", "haiku_confidence": 0.97 },
  "planType": { "value": "PPO", "source_excerpt": "...", "haiku_confidence": 0.93 },
  "metalTier": { "value": null, "source_excerpt": "", "haiku_confidence": 0 },
  "planYear": { "value": 2026, "source_excerpt": "...", "haiku_confidence": 0.96 },
  "groupNumber": { "value": "G-12345", "source_excerpt": "...", "haiku_confidence": 0.91 },
  "networkType": { "value": "Open Access Plus", "source_excerpt": "...", "haiku_confidence": 0.88 },
  "deductibleIndividual": { "value": 1500, "source_excerpt": "...", "haiku_confidence": 0.94 },
  "deductibleFamily": { "value": 3000, "source_excerpt": "...", "haiku_confidence": 0.94 },
  "oopMaxIndividual": { "value": 6500, "source_excerpt": "...", "haiku_confidence": 0.95 },
  "oopMaxFamily": { "value": 13000, "source_excerpt": "...", "haiku_confidence": 0.95 },
  "outDeductibleIndividual": { "value": 3000, "source_excerpt": "...", "haiku_confidence": 0.92 },
  "outDeductibleFamily": { "value": 6000, "source_excerpt": "...", "haiku_confidence": 0.92 },
  "outOopMaxIndividual": { "value": 12000, "source_excerpt": "...", "haiku_confidence": 0.92 },
  "outOopMaxFamily": { "value": 24000, "source_excerpt": "...", "haiku_confidence": 0.92 },
  "isAcaCompliant": { "value": true, "source_excerpt": "Plan Year: 2025 ... Group ID: 34936", "haiku_confidence": 0.78 },
  "acaComplianceBasis": { "value": "inferred_employer_post_2010", "source_excerpt": "Plan Year: 2025", "haiku_confidence": 0.78 }
}

A reminder: the patterns and examples above are universal. They apply across hundreds of carriers, employer groups, and plan structures. Do not pattern-match against specific brand names — apply the universal extraction logic to whatever document chunk you are given.

## CRITICAL OUTPUT FORMAT — JSON ONLY (HARD RULE)

**Return ONLY the JSON object that matches the schema in §4. No commentary. No notes. No analysis.**

Your response MUST:
- Start with the opening \`{\` character.
- End with the matching closing \`}\` character.
- Contain ONLY the JSON object between them — every key from the schema, no extra keys.

Your response MUST NOT contain:
- Any text BEFORE the opening \`{\` (no preamble, no \`\`\`json fence, no greeting)
- Any text AFTER the closing \`}\` (no commentary, no extraction notes, no markdown dividers like \`---\`, no \`### NOTES\` sections, no bullet-point analysis, no "Found in this chunk:" sections, no reasoning narration)
- Markdown headers, code fences, or freeform prose anywhere in the response
- Comments inside the JSON (\`//\` or \`/* */\` are not valid JSON)

The schema fields ARE the contract — every signal the system needs is captured by the field values (\`value\`, \`source_excerpt\`, \`haiku_confidence\`). The system does not parse or use any commentary you might add; appending text after \`}\` breaks downstream JSON parsing and causes all extracted fields to be discarded.

If you cannot extract a field, return it with \`value: null\` and \`source_excerpt: ""\` and \`haiku_confidence: 0\`. Do NOT explain why in free text.

## SECTION 5 — NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawField<T> {
  value?: T | null;
  source_excerpt?: string;
  haiku_confidence?: number;
}

interface RawResponse {
  planName?: RawField<string>;
  insurerName?: RawField<string>;
  planType?: RawField<string>;
  metalTier?: RawField<string>;
  planYear?: RawField<number>;
  groupNumber?: RawField<string>;
  networkType?: RawField<string>;
  deductibleIndividual?: RawField<number>;
  deductibleFamily?: RawField<number>;
  oopMaxIndividual?: RawField<number>;
  oopMaxFamily?: RawField<number>;
  outDeductibleIndividual?: RawField<number>;
  outDeductibleFamily?: RawField<number>;
  outOopMaxIndividual?: RawField<number>;
  outOopMaxFamily?: RawField<number>;
  isAcaCompliant?: RawField<boolean>;
  acaComplianceBasis?: RawField<string>;
}

function buildField<T>(
  raw: RawField<T> | undefined,
  extractionMethod: ExtractionMethod,
  sectionHint: PlanDocSectionHint,
): { value: T | null; patternP8: PlanDocPatternP8Provenance; haikuConfidence?: number } {
  const value = (raw?.value ?? null) as T | null;
  const sourceExcerpt = typeof raw?.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
  return {
    value,
    patternP8: {
      source_excerpt: sourceExcerpt,
      source_excerpt_verified: "not_found",
      source_excerpt_extraction_method: extractionMethod,
      source_section_hint: sectionHint,
      source_section_verified: false,
    },
    haikuConfidence: typeof raw?.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
  };
}

/**
 * Extract plan-identity scalars from a section's text. Used by the parser's
 * multi-section dispatch — same prompt runs on plan_identity + services_cost_sharing
 * + preamble "other" + access_instructions sections; field-merge across chunks
 * recovers scalars wherever they appear.
 *
 * S73 (Session 76): caller passes sectionHint so the Pattern P-8 provenance reflects
 * the actual section the excerpt came from (not always "plan_identity"). Field-merge
 * preserves the winning chunk's section hint.
 */
export async function extractPlanIdentity(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
  sectionHint: PlanDocSectionHint = "plan_identity",
  layout?: PlanDocLayout,
): Promise<PlanDocSectionResult<PlanDocPlanIdentity>> {
  const systemPrompt = await buildInstructions(layout);
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt,
    userContent: sectionText,
    sectionLabel:
      layout === "federal_sbc_8page" || layout === "federal_sbc_csr_variant"
        ? "plan_identity_federal_sbc"
        : "plan_identity",
  });

  const data: PlanDocPlanIdentity = {
    planName: buildField<string>(result.data.planName, extractionMethod, sectionHint),
    insurerName: buildField<string>(result.data.insurerName, extractionMethod, sectionHint),
    planType: buildField<string>(result.data.planType, extractionMethod, sectionHint),
    metalTier: buildField<string>(result.data.metalTier, extractionMethod, sectionHint),
    planYear: buildField<number>(result.data.planYear, extractionMethod, sectionHint),
    groupNumber: buildField<string>(result.data.groupNumber, extractionMethod, sectionHint),
    networkType: buildField<string>(result.data.networkType, extractionMethod, sectionHint),
    deductibleIndividual: buildField<number>(result.data.deductibleIndividual, extractionMethod, sectionHint),
    deductibleFamily: buildField<number>(result.data.deductibleFamily, extractionMethod, sectionHint),
    oopMaxIndividual: buildField<number>(result.data.oopMaxIndividual, extractionMethod, sectionHint),
    oopMaxFamily: buildField<number>(result.data.oopMaxFamily, extractionMethod, sectionHint),
    outDeductibleIndividual: buildField<number>(result.data.outDeductibleIndividual, extractionMethod, sectionHint),
    outDeductibleFamily: buildField<number>(result.data.outDeductibleFamily, extractionMethod, sectionHint),
    outOopMaxIndividual: buildField<number>(result.data.outOopMaxIndividual, extractionMethod, sectionHint),
    outOopMaxFamily: buildField<number>(result.data.outOopMaxFamily, extractionMethod, sectionHint),
    isAcaCompliant: buildField<boolean>(result.data.isAcaCompliant, extractionMethod, sectionHint),
    acaComplianceBasis: buildField<string>(result.data.acaComplianceBasis, extractionMethod, sectionHint),
  };

  return {
    section_type: "plan_identity",
    section_range: sectionRange,
    data,
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
