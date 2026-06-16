// Fixture for the EOC reader-resolution resolver (block spec §9, Gate 1).
// Pure, no DB. Models the real 6480e12b 13-fact shape. Handoff-3 single-card shape:
// priorAuth.{requires,noApproval}, scope-as-chip, Exception detection, conservative suppress.
// Run: npx tsx scripts/eoc-reader-resolution-fixture.ts
import {
  resolveEocReaderSurfaces,
  extractServiceCoverageDetail,
  prettifySlug,
  type EocPriorAuthFact,
  type EocReaderSurfaces,
} from "@/lib/plan/eoc-reader-resolution";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const V = "verified";
function fact(p: Partial<EocPriorAuthFact>): EocPriorAuthFact {
  return { service_slug: null, place_of_service: null, polarity: "requires", criteria_text: "x", source_excerpt: "excerpt", source_excerpt_verified: V, type_confidence: 0.9, ...p };
}

const FACTS: EocPriorAuthFact[] = [
  fact({ polarity: "requires", criteria_text: "Prior authorization is required for the following services." }),
  fact({ polarity: "waived", criteria_text: "No prior authorization for a second medical opinion." }),
  fact({ place_of_service: "emergency", polarity: "waived", criteria_text: "Emergency services do not require prior authorization." }),
  fact({ place_of_service: "inpatient", polarity: "requires", criteria_text: "Inpatient stays require precertification." }),
  fact({ place_of_service: "inpatient", polarity: "requires", criteria_text: "Inpatient stays require precertification." }), // DUP
  fact({ service_slug: "mental_health_inpatient", place_of_service: "inpatient", polarity: "requires", criteria_text: "Inpatient mental health admissions require prior authorization." }),
  fact({ service_slug: "maternity_care", place_of_service: "inpatient", polarity: "waived", criteria_text: "Maternity care does not require prior authorization." }),
  fact({ service_slug: "surgery", place_of_service: "inpatient", polarity: "waived", criteria_text: "Inpatient surgery does not require separate authorization." }), // listed -> SUPPRESS
  fact({ service_slug: "chemotherapy_rx", polarity: "requires", criteria_text: "Chemotherapy requires prior authorization." }), // listed -> SUPPRESS
  fact({ service_slug: "proposed_interventional_pain_management", place_of_service: null, polarity: "requires", criteria_text: "Proposed interventional pain management requires prior authorization." }),
  fact({ polarity: null, criteria_text: "Some non-PA clinical note." }), // null -> dropped
];

const NAMES: Record<string, string> = {
  mental_health_inpatient: "Inpatient mental health",
  maternity_care: "Maternity care",
  proposed_interventional_pain_management: "Interventional pain management",
  surgery: "Surgery",
  chemotherapy_rx: "Chemotherapy",
};
const input = {
  metadata: { eoc_prior_auth_facts: FACTS } as Record<string, unknown>,
  listedServices: [
    { slug: "surgery", priorAuthRequired: true },
    { slug: "chemotherapy_rx", priorAuthRequired: true },
    { slug: "advanced_imaging", priorAuthRequired: true },
  ],
  serviceNameBySlug: (s: string) => NAMES[s] ?? prettifySlug(s),
};

const r: EocReaderSurfaces = resolveEocReaderSurfaces(input);
const { requires, noApproval } = r.priorAuth;
const allText = JSON.stringify(r);

// ── Conservative suppress + null drop ──
ok(!allText.includes("Inpatient surgery does not require separate"), "listed-service waiver (surgery) suppressed everywhere");
ok(!allText.includes("Chemotherapy requires prior authorization"), "listed-service requires (chemo) suppressed (shown inline)");
ok(!allText.includes("Some non-PA clinical note"), "null-polarity fact dropped");

// ── Split counts ──
ok(requires.length === 4, `requires = 4 (got ${requires.length})`);
ok(noApproval.length === 3, `noApproval = 3 (got ${noApproval.length})`);

// ── Plan-wide carries NO chip; setting/service carry one ──
ok(requires.some((s) => s.text.startsWith("Prior authorization is required for the following") && s.scopeChips.length === 0), "true plan-wide requires has NO chip");
ok(requires.some((s) => s.scopeChips.some((c) => c.kind === "scope" && c.label === "Inpatient")), "axis fact (slug-less inpatient) -> 'Inpatient' chip");
ok(requires.some((s) => s.scopeChips.some((c) => c.kind === "scope" && c.label === "Interventional pain management")), "single-service no-setting fact -> service chip");
ok(requires.some((s) => s.scopeChips.some((c) => c.label === "Inpatient mental health")), "service+setting fact -> catalog service-name chip");

// ── Broadest-first sort: requires[0] is the plan-wide (no chip) ──
ok(requires[0].scopeChips.length === 0, "requires sorted broadest-first (plan-wide row first)");

// ── Exception flagging ──
const maternity = noApproval.find((s) => s.scopeChips.some((c) => c.label === "Maternity care"))!;
ok(maternity.scopeChips.some((c) => c.kind === "exc" && c.label === "Exception"), "maternity waiver (inpatient has requires) flagged Exception");
const emergency = noApproval.find((s) => s.scopeChips.some((c) => c.label === "Emergency"))!;
ok(!emergency.scopeChips.some((c) => c.kind === "exc"), "emergency waiver (no requirement to except) is NOT an Exception");

// ── Quotes ──
ok(requires.every((s) => s.quote !== null && s.quoteVerified), "verified facts carry their quote");

// ── Unordered-safety ──
const r2 = resolveEocReaderSurfaces({ ...input, metadata: { eoc_prior_auth_facts: [...FACTS].reverse() } });
ok(JSON.stringify(r2) === allText, "resolver is order-independent (reversed input -> identical output)");

// ── Empty / non-EOC ──
const rEmpty = resolveEocReaderSurfaces({ metadata: null, listedServices: [], serviceNameBySlug: prettifySlug });
ok(rEmpty.priorAuth.requires.length === 0 && rEmpty.priorAuth.noApproval.length === 0 && rEmpty.aboutGroups.length === 0, "absent metadata -> empty no-op");

// ── About-your-plan grouping ──
const prov = (text: string) => ({ service_slug: null, place_of_service: null, text, source_excerpt: "e", source_excerpt_verified: V, type_confidence: 0.9 });
const rAbout = resolveEocReaderSurfaces({
  metadata: { eoc_coverage_provisions: [
    prov("Primary care visits are scheduled within 10 business days."),
    prov("A nurse advice line is available 24/7."),
    prov("Interpreter services are available for appointments."),
    prov("You can access care out of state through the BlueCard program."),
    prov("You have the right to a second medical opinion."),
    prov("Care management helps coordinate your services."),
    prov("Primary care visits are scheduled within 10 business days."), // DUP
  ] } as Record<string, unknown>,
  listedServices: [],
  serviceNameBySlug: prettifySlug,
});
const aboutLabels = rAbout.aboutGroups.map((g) => g.label);
ok(rAbout.aboutGroups.reduce((n, g) => n + g.items.length, 0) === 6, "provisions deduped to 6");
ok(aboutLabels.includes("Getting care") && aboutLabels.includes("Member services") && aboutLabels.includes("Plan details"), `about themed into 3 groups (got ${aboutLabels.join(",")})`);

const rGeneral = resolveEocReaderSurfaces({
  metadata: { eoc_coverage_provisions: [prov("A nurse advice line is available 24/7."), prov("Urgent care is available without a referral.")] } as Record<string, unknown>,
  listedServices: [],
  serviceNameBySlug: prettifySlug,
});
ok(rGeneral.aboutGroups.length === 1 && rGeneral.aboutGroups[0].label === "General", "single-theme provisions collapse to General");

// ── extractServiceCoverageDetail ──
const withDetail = extractServiceCoverageDetail({
  prior_auth_criteria: "Submit clinical docs.",
  prior_auth_all_criteria: ["Submit clinical docs."],
  prior_auth_source_excerpt: "Prior authorization is required...",
  prior_auth_source_excerpt_verified: V,
  medical_necessity_text: "Covered when medically necessary.",
  medical_necessity_criteria: [{ criteria_text: "Covered when medically necessary.", diagnosis_qualifiers: ["M54.5"], source_excerpt: "...", source_excerpt_verified: V }],
  diagnosis_qualifiers: ["M54.5"],
});
ok(withDetail !== null && withDetail.priorAuthCriteria === "Submit clinical docs." && withDetail.medicalNecessityCriteria.length === 1, "extractServiceCoverageDetail returns full detail");
ok(withDetail!.medicalNecessityCriteria[0].diagnosisQualifiers[0] === "M54.5", "MN criteria carries diagnosis qualifiers");
ok(extractServiceCoverageDetail({ how_to_access: "Call us." }) === null, "non-EOC coverage_rules -> null (no fields added)");
ok(extractServiceCoverageDetail(null) === null, "null coverage_rules -> null");
const unver = extractServiceCoverageDetail({ prior_auth_criteria: "x", prior_auth_source_excerpt: "y", prior_auth_source_excerpt_verified: "not_found" });
ok(unver !== null && unver.priorAuthSourceExcerpt === null && unver.priorAuthSourceExcerptVerified === false, "unverified PA excerpt dropped (no green quote)");

console.log(`\n✅ eoc-reader-resolution fixture (handoff-3 shape): ${passed}/${passed} assertions passed`);
