/**
 * S185 — EOC write-once-per-(parse, slug) accumulator fixture (TS, runnable):
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/eoc-mn-accumulate.ts
 *
 * Proves the multi-passage clobber fix:
 *   (1) mergeClinicalMnFragments — ALL passages kept (lossless medical_necessity_criteria[],
 *       document order, per-passage dx/excerpt/axis/confidence), scalars mirror the FIRST
 *       passage (Section-A parity), diagnosis_qualifiers unioned; provenance cites the
 *       highest-extraction-confidence passage (ties → first). Single-passage shape = the four
 *       legacy keys unchanged + the array of one (additive).
 *   (2) mergeProsePaFragments — Section A's exact key family (prior_auth_criteria = first +
 *       prior_auth_all_criteria[] = all); ONE provenance source per slug (was: per-criterion
 *       last-write-wins on coverage_rules AND field_provenance.prior_auth_required).
 *   (3) mergeCodeAnchoredPaFragments — VERBATIM equivalence with Section A's historical inline
 *       payload (first code anchors; criteria[0] ?? code.pa_criteria ?? null).
 *   (4) EocCoverageAccumulator flush mechanics — ONE upsert per slug; prose-PA before clinical
 *       (PA may create the base cell a same-slug clinical write lands on); no phantom cell for
 *       clinical-only slugs (allowBaseCell:false); no_service_id / write_failed outcomes carry
 *       fragments for criterion-denominated telemetry. The merge is type-agnostic (flag-OFF
 *       routes every valid-slug criterion here — multi-type passages accumulate the same way).
 */
import {
  EocCoverageAccumulator,
  mergeClinicalMnFragments,
  mergeProsePaFragments,
  mergeCodeAnchoredPaFragments,
  PLAN_COVERED_ONCONFLICT,
} from "../../../../src/lib/plan/coverage-targeting";
import type { MedicalNecessityCriterion, PriorAuthCode } from "../../../../src/lib/eoc/types";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}`);
    failures++;
  }
}

// ── factories ────────────────────────────────────────────────────────────────────────────────

function crit(over: Partial<MedicalNecessityCriterion> & { criteria_text: string }): MedicalNecessityCriterion {
  return {
    service_slug_hint: "er_visit",
    diagnosis_qualifiers: [],
    type: "clinical_criterion",
    type_confidence: null,
    pa_polarity: null,
    place_of_service: null,
    source_excerpt: "default excerpt",
    source_excerpt_verified: "verified",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "medical_necessity",
    source_section_verified: true,
    ...over,
  } as MedicalNecessityCriterion;
}

function paCode(over: Partial<PriorAuthCode> & { billing_code: string }): PriorAuthCode {
  return {
    billing_code_type: "CPT",
    pa_criteria: null,
    haiku_confidence: 0.7,
    source_excerpt: "PA table excerpt",
    source_excerpt_verified: "verified",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "prior_auth_codes",
    source_section_verified: true,
    ...over,
  } as PriorAuthCode;
}

// ── stateful mock supabase (service_catalog resolve + plan_covered_services cells) ───────────

interface FakeCell {
  id: string;
  service_id: string;
  coverage_rules: Record<string, unknown> | null;
  field_provenance: Record<string, unknown> | null;
  [k: string]: unknown;
}

function makeFakeDb(opts: {
  slugToId: Record<string, string | undefined>;
  cells: FakeCell[];
  throwOnUpdate?: boolean;
  /** Production-realistic DB failure: update resolves { error } WITHOUT throwing (swallowed upstream). */
  returnErrorOnUpdate?: boolean;
}) {
  const upserts: Array<{ rows: FakeCell[]; onConflict: string }> = [];
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake: any = {
    from(table: string) {
      if (table === "service_catalog") {
        return {
          select() {
            return {
              eq(_c: string, slug: string) {
                const id = opts.slugToId[slug];
                return { maybeSingle: () => Promise.resolve({ data: id ? { id } : null, error: null }) };
              },
            };
          },
        };
      }
      return {
        select() {
          return {
            eq() {
              return {
                eq(_c2: string, serviceId: string) {
                  return Promise.resolve({
                    data: opts.cells.filter((c) => c.service_id === serviceId).map((c) => ({ ...c })),
                    error: null,
                  });
                },
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          if (opts.throwOnUpdate) throw new Error("update boom");
          return {
            eq(_c: string, id: string) {
              if (opts.returnErrorOnUpdate) return Promise.resolve({ error: { message: "db says no" } });
              const cell = opts.cells.find((x) => x.id === id);
              if (cell) Object.assign(cell, payload);
              updates.push({ id, payload });
              return Promise.resolve({ error: null });
            },
          };
        },
        upsert(rows: FakeCell[] | FakeCell, o: { onConflict: string }) {
          const arr = Array.isArray(rows) ? rows : [rows];
          for (const r of arr) opts.cells.push({ ...r, id: `cell-${opts.cells.length + 1}` });
          upserts.push({ rows: arr, onConflict: o.onConflict });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return { fake, upserts, updates, cells: opts.cells };
}

// ── (1) clinical merge ───────────────────────────────────────────────────────────────────────

function testClinicalMerge(): void {
  const c1 = crit({
    criteria_text: "ER visits covered when emergent",
    diagnosis_qualifiers: ["R07.9"],
    source_excerpt: "e1",
    source_excerpt_verified: "verified",
    haiku_confidence: 0.8,
    type_confidence: 0.9,
  });
  const c2 = crit({
    criteria_text: "Not covered when non-emergency transport was available",
    diagnosis_qualifiers: ["R07.9", "Z00.00"],
    source_excerpt: "e2",
    source_excerpt_verified: "not_found",
    place_of_service: "emergency",
    haiku_confidence: 0.95,
    type: "prior_auth", // flag-OFF routes every valid-slug criterion here — merge is type-agnostic
  });
  const c3 = crit({ criteria_text: "OON ER cost-shares as in-network", source_excerpt: "e3" });

  const merged = mergeClinicalMnFragments([c1, c2, c3]);
  check("clinical: merge returns a payload", merged !== null);
  if (!merged) return;
  const rules = merged.coverageRules;
  const entries = rules.medical_necessity_criteria as Array<Record<string, unknown>>;

  check("clinical: ALL passages kept in document order", entries.length === 3 &&
    entries[0].criteria_text === c1.criteria_text &&
    entries[1].criteria_text === c2.criteria_text &&
    entries[2].criteria_text === c3.criteria_text);
  check("clinical: scalars mirror the FIRST passage (text + excerpt pair)",
    rules.medical_necessity_text === c1.criteria_text &&
    rules.medical_necessity_source_excerpt === "e1" &&
    rules.medical_necessity_source_excerpt_verified === "verified");
  check("clinical: diagnosis_qualifiers unioned, deduped, first-occurrence order",
    JSON.stringify(rules.diagnosis_qualifiers) === JSON.stringify(["R07.9", "Z00.00"]));
  check("clinical: entries keep per-passage dx + excerpt pairing",
    JSON.stringify(entries[1].diagnosis_qualifiers) === JSON.stringify(["R07.9", "Z00.00"]) &&
    entries[1].source_excerpt === "e2" && entries[2].source_excerpt === "e3");
  check("clinical: axis/confidence retained only when present",
    entries[1].place_of_service === "emergency" &&
    !("place_of_service" in entries[0]) &&
    entries[0].haiku_confidence === 0.8 &&
    !("haiku_confidence" in entries[2]) &&
    entries[0].type_confidence === 0.9 &&
    !("type_confidence" in entries[1]));
  check("clinical: provenance cites the FIRST passage (key↔value consistency with the mirrored scalar)",
    merged.provenanceSource === c1);

  const tie = mergeClinicalMnFragments([c3, crit({ criteria_text: "second, also no confidence" })]);
  check("clinical: provenance is first regardless of confidence spread", tie?.provenanceSource === c3);

  const single = mergeClinicalMnFragments([c1]);
  check("clinical: single passage → legacy scalar keys unchanged + array of one",
    single !== null &&
    single.coverageRules.medical_necessity_text === c1.criteria_text &&
    JSON.stringify(single.coverageRules.diagnosis_qualifiers) === JSON.stringify(["R07.9"]) &&
    single.coverageRules.medical_necessity_source_excerpt === "e1" &&
    single.coverageRules.medical_necessity_source_excerpt_verified === "verified" &&
    (single.coverageRules.medical_necessity_criteria as unknown[]).length === 1);
  check("clinical: empty input → null (caller skips)", mergeClinicalMnFragments([]) === null);
}

// ── (2) prose-PA merge ───────────────────────────────────────────────────────────────────────

function testProsePaMerge(): void {
  const p1 = crit({
    criteria_text: "MRI requires prior authorization",
    source_excerpt: "pa1",
    haiku_confidence: 0.6,
    type: "prior_auth",
    pa_polarity: "requires",
  });
  const p2 = crit({
    criteria_text: "Advanced imaging precertification required in outpatient settings",
    source_excerpt: "pa2",
    haiku_confidence: 0.9,
    type: "prior_auth",
    pa_polarity: "requires",
  });
  const merged = mergeProsePaFragments([p1, p2]);
  check("prose-PA: Section A key family (first + all)", merged !== null &&
    merged.coverageRules.requires_prior_auth === true &&
    merged.coverageRules.prior_auth_criteria === p1.criteria_text &&
    JSON.stringify(merged.coverageRules.prior_auth_all_criteria) ===
      JSON.stringify([p1.criteria_text, p2.criteria_text]) &&
    merged.coverageRules.prior_auth_source_excerpt === "pa1");
  check("prose-PA: ONE provenance source per slug = highest confidence", merged?.provenanceSource === p2);
  check("prose-PA: empty input → null", mergeProsePaFragments([]) === null);
}

// ── (3) code-anchored PA merge — equivalence with Section A's historical inline payload ──────

function testCodeAnchoredEquivalence(): void {
  const first = paCode({ billing_code: "70551", pa_criteria: "over $500", source_excerpt: "PA list p3" });
  const second = paCode({ billing_code: "70552", pa_criteria: "site of service review", source_excerpt: "PA list p4" });
  const acc = { code: first, criteria: ["over $500", "site of service review"] };
  const merged = mergeCodeAnchoredPaFragments(acc);

  // The historical inline payload, constructed verbatim (process-eoc.ts pre-S185):
  const historical: Record<string, unknown> = {
    requires_prior_auth: true,
    prior_auth_criteria: acc.criteria[0] ?? acc.code.pa_criteria ?? null,
    prior_auth_all_criteria: acc.criteria,
    prior_auth_source_excerpt: acc.code.source_excerpt,
    prior_auth_source_excerpt_verified: acc.code.source_excerpt_verified,
  };
  check("code-PA: payload byte-equivalent to the historical inline construction",
    JSON.stringify(merged.coverageRules) === JSON.stringify(historical));
  check("code-PA: exact key set (no additions, no drops)",
    JSON.stringify(Object.keys(merged.coverageRules).sort()) ===
      JSON.stringify(Object.keys(historical).sort()));
  check("code-PA: provenance source = the anchoring (first) code", merged.provenanceSource === first &&
    merged.provenanceSource !== second);
  check("code-PA: empty criteria + null pa_criteria → null (verbatim ?? chain)",
    mergeCodeAnchoredPaFragments({ code: paCode({ billing_code: "99213", pa_criteria: null }), criteria: [] })
      .coverageRules.prior_auth_criteria === null);
  check("code-PA: empty criteria + code.pa_criteria → falls back to the code's criteria",
    mergeCodeAnchoredPaFragments({ code: paCode({ billing_code: "99213", pa_criteria: "fallback" }), criteria: [] })
      .coverageRules.prior_auth_criteria === "fallback");
}

// ── (4) accumulator fold + flush mechanics ───────────────────────────────────────────────────

async function testAccumulatorFoldEquivalence(): Promise<void> {
  // Old Section A closure, replicated verbatim for comparison:
  const oldBySlug = new Map<string, { code: PriorAuthCode; criteria: string[] }>();
  const oldAccumulate = (slug: string, code: PriorAuthCode): void => {
    const a = oldBySlug.get(slug) ?? { code, criteria: [] };
    if (code.pa_criteria) a.criteria.push(code.pa_criteria);
    oldBySlug.set(slug, a);
  };
  const k1 = paCode({ billing_code: "1", pa_criteria: "k1", source_excerpt: "first-code-excerpt" });
  const k2 = paCode({ billing_code: "2", pa_criteria: "k2", source_excerpt: "second-code-excerpt" });
  const k3 = paCode({ billing_code: "3", pa_criteria: null, source_excerpt: "third-code-excerpt" });
  for (const c of [k1, k2, k3]) oldAccumulate("mri", c);

  const accum = new EocCoverageAccumulator();
  for (const c of [k1, k2, k3]) accum.addCodeAnchoredPa("mri", c);
  const db = makeFakeDb({ slugToId: { mri: "svc-mri" }, cells: [
    { id: "c1", service_id: "svc-mri", coverage_rules: { keep: 1 }, field_provenance: null },
  ] });
  const outcomes = await accum.flushCodeAnchoredPa(db.fake, "plan1");
  const old = oldBySlug.get("mri")!;

  check("fold: one written outcome for the slug", outcomes.length === 1 && outcomes[0].status === "written");
  const payload = db.updates[0]?.payload ?? {};
  const rules = (payload.coverage_rules ?? {}) as Record<string, unknown>;
  check("fold: equivalence with the old closure (first code anchors; criteria in order)",
    JSON.stringify(rules.prior_auth_all_criteria) === JSON.stringify(old.criteria) &&
    rules.prior_auth_criteria === (old.criteria[0] ?? old.code.pa_criteria ?? null) &&
    rules.prior_auth_source_excerpt === "first-code-excerpt");
  check("fold: typed column set + existing coverage_rules keys preserved",
    payload.prior_auth_required === true && rules.keep === 1);
  const prov = (payload.field_provenance ?? {}) as Record<string, Record<string, unknown>>;
  check("fold: cite-grade provenance entry from the anchoring code",
    prov.prior_auth_required?.source === "doc_extraction_eoc" &&
    prov.prior_auth_required?.source_excerpt === "first-code-excerpt");
}

async function testFlushMechanics(): Promise<void> {
  // Same slug carries prose-PA AND clinical criteria; a second slug is clinical-only with no cells.
  const accum = new EocCoverageAccumulator();
  const pa = crit({ criteria_text: "Surgery requires prior authorization", type: "prior_auth", pa_polarity: "requires", haiku_confidence: 0.9, source_excerpt: "pa-x" });
  const cl1 = crit({ criteria_text: "Surgery covered when medically necessary", haiku_confidence: 0.7, source_excerpt: "cl-1" });
  const cl2 = crit({ criteria_text: "Pre-surgical program completion required", haiku_confidence: 0.85, source_excerpt: "cl-2", diagnosis_qualifiers: ["E66.01"] });
  accum.addProsePa("surgery", pa);
  accum.addClinical("surgery", cl1);
  accum.addClinical("surgery", cl2);
  accum.addClinical("orphan_service", crit({ criteria_text: "never lands (no cells, allowBaseCell:false)" }));

  const db = makeFakeDb({ slugToId: { surgery: "svc-surg", orphan_service: "svc-orphan" }, cells: [] });

  // Prose-PA first: creates the base cell (allowBaseCell:true)…
  const paOut = await accum.flushProsePa(db.fake, "plan1");
  check("flush: prose-PA creates the base cell via the 4-col onConflict",
    paOut.length === 1 && paOut[0].status === "written" &&
    db.upserts.length === 1 && db.upserts[0].onConflict === PLAN_COVERED_ONCONFLICT &&
    db.cells.length === 1 && db.cells[0].prior_auth_required === true);

  // …then clinical lands on that same cell; the orphan slug writes nothing (no phantom row).
  const mnOut = await accum.flushClinicalMn(db.fake, "plan1");
  const surgOut = mnOut.find((o) => o.slug === "surgery");
  const orphanOut = mnOut.find((o) => o.slug === "orphan_service");
  check("flush: clinical lands on the PA-created cell (ONE update, same slug)",
    surgOut?.status === "written" && surgOut.cellsWritten === 1 && db.updates.length === 1);
  check("flush: clinical-only slug with no cells → 0 writes, no phantom covered row",
    orphanOut?.status === "written" && orphanOut.cellsWritten === 0 &&
    db.cells.length === 1 && db.upserts.length === 1);

  const cell = db.cells[0];
  const rules = (cell.coverage_rules ?? {}) as Record<string, unknown>;
  check("flush: final cell carries BOTH key families (PA + clinical) — disjoint, no clobber",
    rules.requires_prior_auth === true &&
    rules.prior_auth_criteria === pa.criteria_text &&
    rules.medical_necessity_text === cl1.criteria_text &&
    (rules.medical_necessity_criteria as unknown[]).length === 2);
  const prov = (cell.field_provenance ?? {}) as Record<string, Record<string, unknown>>;
  check("flush: field_provenance holds BOTH entries (prior_auth_required + medical_necessity_text)",
    prov.prior_auth_required?.source === "doc_extraction_eoc" &&
    prov.medical_necessity_text?.source === "doc_extraction_eoc");
  check("flush: clinical provenance cites the FIRST passage (matches the mirrored scalar)",
    prov.medical_necessity_text?.source_excerpt === "cl-1" &&
    prov.medical_necessity_text?.haiku_confidence === 0.7);
  check("flush: fragments carried on outcomes (criterion-denominated telemetry intact)",
    surgOut?.fragments.length === 2 && paOut[0].fragments.length === 1);
}

async function testFlushFailureModes(): Promise<void> {
  const accum = new EocCoverageAccumulator();
  accum.addClinical("ghost_slug", crit({ criteria_text: "no catalog row" }));
  const db1 = makeFakeDb({ slugToId: {}, cells: [] });
  const out1 = await accum.flushClinicalMn(db1.fake, "plan1");
  check("failure: unknown slug → no_service_id outcome, fragments carried, zero writes",
    out1.length === 1 && out1[0].status === "no_service_id" && out1[0].fragments.length === 1 &&
    db1.updates.length === 0 && db1.upserts.length === 0);

  const accum2 = new EocCoverageAccumulator();
  accum2.addProsePa("mri", crit({ criteria_text: "PA required", type: "prior_auth", pa_polarity: "requires" }));
  accum2.addProsePa("mri", crit({ criteria_text: "PA also required here", type: "prior_auth", pa_polarity: "requires" }));
  const db2 = makeFakeDb({
    slugToId: { mri: "svc-mri" },
    cells: [{ id: "c1", service_id: "svc-mri", coverage_rules: null, field_provenance: null }],
    throwOnUpdate: true,
  });
  const out2 = await accum2.flushProsePa(db2.fake, "plan1");
  check("failure: throwing write → write_failed outcome with error + BOTH fragments (×N tallies)",
    out2.length === 1 && out2[0].status === "write_failed" &&
    (out2[0].error ?? "").includes("update boom") && out2[0].fragments.length === 2);
}

async function testReviewFindings(): Promise<void> {
  // (a) Exact-duplicate collapse — same text+axis collapses (keep first); same text DIFFERENT axis survives.
  const dupA = crit({ criteria_text: "PT covered when restorative", diagnosis_qualifiers: ["M54.5"] });
  const dupB = crit({ criteria_text: "PT  covered when\nrestorative", diagnosis_qualifiers: ["M62.81"] });
  const axisC = crit({ criteria_text: "PT covered when restorative", place_of_service: "outpatient" });
  const m = mergeClinicalMnFragments([dupA, dupB, axisC]);
  const ents = (m?.coverageRules.medical_necessity_criteria ?? []) as Array<Record<string, unknown>>;
  check("dedup: exact duplicate (normalized) collapses to first; different-axis twin survives",
    ents.length === 2 && !("place_of_service" in ents[0]) && ents[1].place_of_service === "outpatient");
  check("dedup: dropped duplicate still contributes to the dx union",
    JSON.stringify(m?.coverageRules.diagnosis_qualifiers) === JSON.stringify(["M54.5", "M62.81"]));
  const pDup = mergeProsePaFragments([
    crit({ criteria_text: "MRI requires PA", type: "prior_auth", pa_polarity: "requires" }),
    crit({ criteria_text: "MRI  requires PA", type: "prior_auth", pa_polarity: "requires" }),
  ]);
  check("dedup: prose-PA all_criteria collapses exact duplicates",
    (pDup?.coverageRules.prior_auth_all_criteria as string[]).length === 1);

  // (b) Multi-cell service (mig 157 reality) — every cell patched, per-cell other-keys preserved.
  const accumMc = new EocCoverageAccumulator();
  accumMc.addClinical("imaging", crit({ criteria_text: "criteria for imaging" }));
  const dbMc = makeFakeDb({ slugToId: { imaging: "svc-img" }, cells: [
    { id: "fac", service_id: "svc-img", coverage_rules: { keep_fac: 1 }, field_provenance: null },
    { id: "pro", service_id: "svc-img", coverage_rules: { keep_pro: 2 }, field_provenance: null },
  ] });
  const mcOut = await accumMc.flushClinicalMn(dbMc.fake, "plan1");
  const fac = dbMc.cells.find((c) => c.id === "fac");
  const pro = dbMc.cells.find((c) => c.id === "pro");
  check("multi-cell: both cells patched (cellsWritten 2), each preserving its own keys",
    mcOut[0]?.cellsWritten === 2 &&
    (fac?.coverage_rules as Record<string, unknown>).keep_fac === 1 &&
    (pro?.coverage_rules as Record<string, unknown>).keep_pro === 2 &&
    (fac?.coverage_rules as Record<string, unknown>).medical_necessity_text === "criteria for imaging" &&
    (pro?.coverage_rules as Record<string, unknown>).medical_necessity_text === "criteria for imaging");

  // (c) Swallowed supabase error objects (no throw) — LOCKS carried pre-S185 semantics.
  const accumErr = new EocCoverageAccumulator();
  accumErr.addProsePa("mri", crit({ criteria_text: "PA", type: "prior_auth", pa_polarity: "requires" }));
  const dbErr = makeFakeDb({ slugToId: { mri: "svc-mri" }, cells: [
    { id: "c1", service_id: "svc-mri", coverage_rules: null, field_provenance: null },
  ], returnErrorOnUpdate: true });
  const errOut = await accumErr.flushProsePa(dbErr.fake, "plan1");
  check("carried semantics locked: swallowed DB error → status 'written' with cellsWritten 0 (pre-S185 parity)",
    errOut[0]?.status === "written" && errOut[0]?.cellsWritten === 0);

  // (d) Section A write-failure disengages the code-wins dedup → prose-PA then writes the slug.
  const accumFail = new EocCoverageAccumulator();
  accumFail.addCodeAnchoredPa("mri", paCode({ billing_code: "70551", pa_criteria: "code PA" }));
  const dbFail = makeFakeDb({ slugToId: { mri: "svc-mri" }, cells: [
    { id: "c1", service_id: "svc-mri", coverage_rules: null, field_provenance: null },
  ], throwOnUpdate: true });
  const failOut = await accumFail.flushCodeAnchoredPa(dbFail.fake, "plan1");
  check("code-PA write failure → write_failed (caller will NOT add the slug to codeAnchoredPaSlugs)",
    failOut[0]?.status === "write_failed");
  accumFail.addProsePa("mri", crit({ criteria_text: "prose PA", type: "prior_auth", pa_polarity: "requires" }));
  const dbOk = makeFakeDb({ slugToId: { mri: "svc-mri" }, cells: [
    { id: "c1", service_id: "svc-mri", coverage_rules: null, field_provenance: null },
  ] });
  const proseOut = await accumFail.flushProsePa(dbOk.fake, "plan1");
  check("…and the prose-PA fallback for that slug then writes (documented dedup-disengage interplay)",
    proseOut[0]?.status === "written");

  // (e) Flush drains its map: a second flush of the same kind is a structural no-op.
  const reOut = await accumFail.flushProsePa(dbOk.fake, "plan1");
  check("double-flush: second flush returns [] and writes nothing",
    reOut.length === 0 && dbOk.updates.length === 1);
}

async function main(): Promise<void> {
  console.log("(1) mergeClinicalMnFragments");
  testClinicalMerge();
  console.log("(2) mergeProsePaFragments");
  testProsePaMerge();
  console.log("(3) mergeCodeAnchoredPaFragments — historical equivalence");
  testCodeAnchoredEquivalence();
  console.log("(4) accumulator fold equivalence + flush mechanics");
  await testAccumulatorFoldEquivalence();
  await testFlushMechanics();
  await testFlushFailureModes();
  console.log("(5) review findings — dedup, multi-cell, carried semantics, dedup-disengage, drain");
  await testReviewFindings();
  if (failures > 0) {
    console.error(`\n✗ EOC-MN-ACCUMULATE FIXTURE: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\n>>> S185 EOC-MN-ACCUMULATE FIXTURE: PASS <<<");
}
void main();
