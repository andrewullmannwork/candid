// Fixture for the EOC reader-resolution resolver (block spec §9, Gate 1).
// Pure, no DB. Models the real 6480e12b 13-fact shape (plan-wide / setting / orphan
// + a listed-service waiver that MUST be suppressed). Run: npx tsx scripts/eoc-reader-resolution-fixture.ts
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
  return {
    service_slug: null,
    place_of_service: null,
    polarity: "requires",
    criteria_text: "x",
    source_excerpt: "excerpt",
    source_excerpt_verified: V,
    type_confidence: 0.9,
    ...p,
  };
}

// 13-fact set modeled on 6480e12b.
const FACTS: EocPriorAuthFact[] = [
  fact({ polarity: "requires", criteria_text: "Prior authorization is required for the following services." }),
  fact({ polarity: "waived", criteria_text: "No prior authorization for a second medical opinion." }),
  fact({ place_of_service: "emergency", polarity: "waived", criteria_text: "Emergency services do not require prior authorization." }),
  fact({ place_of_service: "inpatient", polarity: "requires", criteria_text: "Inpatient stays require precertification." }),
  fact({ place_of_service: "inpatient", polarity: "requires", criteria_text: "Inpatient stays require precertification." }), // DUP
  fact({ service_slug: "mental_health_inpatient", place_of_service: "inpatient", polarity: "requires", criteria_text: "Inpatient mental health admissions require prior authorization." }),
  fact({ service_slug: "maternity_care", place_of_service: "inpatient", polarity: "waived", criteria_text: "Maternity care does not require prior authorization." }),
  fact({ service_slug: "surgery", place_of_service: "inpatient", polarity: "waived", criteria_text: "Inpatient surgery does not require separate authorization." }), // listed pa=true -> SUPPRESS
  fact({ service_slug: "chemotherapy_rx", polarity: "requires", criteria_text: "Chemotherapy requires prior authorization." }), // listed -> shown inline -> SUPPRESS
  fact({ service_slug: "proposed_interventional_pain_management", place_of_service: null, polarity: "requires", criteria_text: "Proposed interventional pain management requires prior authorization." }),
  fact({ polarity: null, criteria_text: "Some non-PA clinical note." }), // null polarity -> dropped
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
const allText = JSON.stringify(r);

// ── Conservative suppress ──
ok(!allText.includes("Inpatient surgery does not require separate"), "listed-service waiver (surgery) suppressed everywhere");
ok(!allText.includes("Chemotherapy requires prior authorization"), "listed-service requires (chemo) suppressed from aggregate (shown inline)");
// ── null polarity dropped ──
ok(!allText.includes("Some non-PA clinical note"), "null-polarity fact dropped");

// ── Plan-wide card ──
ok(r.planWidePA.length === 3, `plan-wide has 3 statements (got ${r.planWidePA.length})`);
ok(r.planWidePA.some((s) => s.text.startsWith("Prior authorization is required for the following") && s.scopeChips.some((c) => c.kind === "plan" && c.label === "Plan-wide")), "true plan-wide fact carries the Plan-wide chip");
ok(r.planWidePA.some((s) => s.scopeChips.some((c) => c.kind === "scope" && c.label === "Interventional pain management")), "single-service no-setting fact -> plan-wide with its service chip");
ok(r.planWidePA[0].polarity === "requires", "plan-wide sorted requirements-first");

// ── By-location card ──
const settings = r.byLocationPA.map((g) => g.setting);
ok(settings[0] === "Inpatient" && settings.includes("Emergency"), `by-location ordered Inpatient before Emergency (got ${settings.join(",")})`);
const inpatient = r.byLocationPA.find((g) => g.setting === "Inpatient")!;
ok(inpatient.statements.filter((s) => s.text.startsWith("Inpatient stays require")).length === 1, "inpatient requires deduped to 1");
ok(inpatient.statements.length === 3, `inpatient group has 3 statements (got ${inpatient.statements.length})`);
const maternity = inpatient.statements.find((s) => s.scopeChips.some((c) => c.label === "Maternity care"))!;
ok(maternity.isException === true, "maternity waiver in a group-with-requires is flagged Exception");
ok(maternity.scopeChips.every((c) => c.label !== "Inpatient"), "by-location row does not repeat the setting as a chip");
const emergency = r.byLocationPA.find((g) => g.setting === "Emergency")!;
ok(emergency.statements[0].isException === false, "emergency-only-waiver group is NOT an exception (no requirement to except)");
ok(emergency.statements[0].quote !== null && emergency.statements[0].quoteVerified, "verified fact carries its quote");

// ── Unordered-safety ──
const shuffled = [...FACTS].reverse();
const r2 = resolveEocReaderSurfaces({ ...input, metadata: { eoc_prior_auth_facts: shuffled } });
ok(JSON.stringify(r2) === allText, "resolver is order-independent (reversed input -> identical output)");

// ── Empty / non-EOC ──
const rEmpty = resolveEocReaderSurfaces({ metadata: null, listedServices: [], serviceNameBySlug: prettifySlug });
ok(rEmpty.planWidePA.length === 0 && rEmpty.byLocationPA.length === 0 && rEmpty.aboutGroups.length === 0, "absent metadata -> empty no-op");

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

// General fallback when a single theme.
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
ok(extractServiceCoverageDetail({ how_to_access: "Call us." }) === null, "non-EOC coverage_rules (how_to_access only) -> null (no fields added)");
ok(extractServiceCoverageDetail(null) === null, "null coverage_rules -> null");
// Unverified excerpt is not surfaced as a quote.
const unver = extractServiceCoverageDetail({ prior_auth_criteria: "x", prior_auth_source_excerpt: "y", prior_auth_source_excerpt_verified: "not_found" });
ok(unver !== null && unver.priorAuthSourceExcerpt === null && unver.priorAuthSourceExcerptVerified === false, "unverified PA excerpt is dropped (no green quote)");

console.log(`\n✅ eoc-reader-resolution fixture: ${passed}/${passed} assertions passed`);
