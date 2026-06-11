/**
 * S193 D-P2-4 — prose-PA leg merge fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/eoc-pa-leg.ts
 *
 * Proves the pure `mergePriorAuthProseLeg` (parser.ts) — the ONLY new data-shaping logic of the
 * D-P2-4 leg:
 *   1. PA SWEEP, not a second extractor: ONLY prior_auth-typed leg entries survive; clinical /
 *      admin entries from the broad PA region are DROPPED (over-capture cannot regress).
 *   2. Survivors are retagged source_section_hint='prior_auth_codes' (their true region).
 *   3. mn-null + PA leg → a section result exists (leg-shaped, criteria = PA-only).
 *   4. leg-null / PA-empty leg → mn returned unchanged (same reference — byte-identical no-op).
 *   5. Cost/token fields sum (section-level honesty); mn criteria order preserved, leg appended.
 */
import { mergePriorAuthProseLeg } from "@/lib/eoc/parser";
import type {
  EOCSectionResult,
  MedicalNecessityContentType,
  MedicalNecessityCriterion,
  MedicalNecessityData,
} from "@/lib/eoc/types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}`);
  }
}

function crit(type: MedicalNecessityContentType, slug: string | null, text: string): MedicalNecessityCriterion {
  return {
    type,
    type_confidence: 0.9,
    pa_polarity: type === "prior_auth" ? "requires" : null,
    place_of_service: null,
    service_slug_hint: slug,
    criteria_text: text,
    diagnosis_qualifiers: [],
    source_excerpt: text,
    source_excerpt_verified: "verified",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "medical_necessity",
    source_section_verified: true,
    haiku_confidence: 0.9,
  } as MedicalNecessityCriterion;
}

function section(criteria: MedicalNecessityCriterion[], cost = 0.01): EOCSectionResult<MedicalNecessityData> {
  return {
    section_type: "medical_necessity",
    section_range: { start: 0, end: 1000 },
    data: { criteria },
    haiku_cost_usd: cost,
    haiku_input_tokens: 100,
    haiku_output_tokens: 50,
    haiku_cache_create_tokens: 10,
    haiku_cache_read_tokens: 20,
    warnings: [],
  } as unknown as EOCSectionResult<MedicalNecessityData>;
}

console.log("S193 D-P2-4 — mergePriorAuthProseLeg fixture\n");

const mn = section([crit("clinical_criterion", "surgery", "mn clinical"), crit("prior_auth", "surgery", "mn pa")], 0.02);
const leg = section(
  [
    crit("prior_auth", "prescription_drugs", "leg pa 1"),
    crit("clinical_criterion", "surgery", "leg clinical — MUST DROP"),
    crit("admin_provision", null, "leg admin — MUST DROP"),
    crit("prior_auth", null, "leg pa 2 scenario"),
  ],
  0.03,
);

// 1+2: filter + retag
const merged = mergePriorAuthProseLeg(mn, leg);
check("merged exists", merged !== null);
const mc: MedicalNecessityCriterion[] = merged ? merged.data.criteria : [];
check("mn criteria preserved first (order)", mc[0]?.criteria_text === "mn clinical" && mc[1]?.criteria_text === "mn pa");
check("leg PA entries appended (2 of 4 survive)", mc.length === 4);
check("leg clinical DROPPED", !mc.some((c) => c.criteria_text.includes("leg clinical")));
check("leg admin DROPPED", !mc.some((c) => c.criteria_text.includes("leg admin")));
check("survivors retagged to prior_auth_codes", mc.slice(2).every((c) => c.source_section_hint === "prior_auth_codes"));
check("mn entries keep their own hint", mc[0]?.source_section_hint === "medical_necessity");

// 5: cost/token sums
check("cost summed", merged !== null && Math.abs(merged.haiku_cost_usd - 0.05) < 1e-9);
check("input tokens summed", merged !== null && merged.haiku_input_tokens === 200);
check("cache tokens summed", merged !== null && merged.haiku_cache_read_tokens === 40);

// 3: mn-null + PA leg
const solo = mergePriorAuthProseLeg(null, leg);
const sc: MedicalNecessityCriterion[] = solo ? solo.data.criteria : [];
check("mn-null: leg-shaped result exists", solo !== null && sc.length === 2);
check("mn-null: only PA entries", sc.every((c) => c.type === "prior_auth"));
check("mn-null: retagged", sc.every((c) => c.source_section_hint === "prior_auth_codes"));

// 4: no-op paths return the SAME mn reference (byte-identical)
check("leg-null → mn unchanged (same ref)", mergePriorAuthProseLeg(mn, null) === mn);
const emptyPaLeg = section([crit("admin_provision", null, "only admin")], 0.01);
check("PA-empty leg → mn unchanged (same ref)", mergePriorAuthProseLeg(mn, emptyPaLeg) === mn);
check("both null → null", mergePriorAuthProseLeg(null, null) === null);

// input immutability (the helper must not mutate the leg)
check("leg input not mutated", leg.data.criteria.length === 4 && leg.data.criteria[0].source_section_hint === "medical_necessity");

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
