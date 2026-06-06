/**
 * mig 154 Phase-1c re-map — SEED generator + DRY-RUN AUDITOR (S171 thesaurus Step 5).
 *
 * The re-map = standard federal-SBC benefit-row labels -> representative slug, written as CODE-LESS
 * signature-cache rows (billing_code_mappings) the resolver serves at Tier-1b DETERMINISTICALLY.
 *
 * SOURCE = the SBC standard vocabulary (general; correct on ANY SBC) — NOT the GT oracle strings. The
 * audit below PROVES (with GT data) that each seed signature catches ONLY its intended concept (0
 * collisions, 0 no-concept over-map) and quantifies the flippy entries it stabilizes — and SEPARATES the
 * residual flippy/unmatched entries the seed does NOT cover (the noise bucket that stays Haiku-resolved +
 * quarantined; never promoted as truth). Run BEFORE writing/applying mig 154.
 *
 *   audit:  npx tsx scripts/calibration/thesaurus/seed-remap.ts <gt.json> [forward.json] [convergence.json]
 *   emit:   ... --emit-sql   (prints the mig 154 INSERTs; signatures computed via the REAL normalizer)
 */
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { normalizeDescriptionSignature } from "@/lib/parser/code-identity";
import type { GtService, ForwardMapEntry, ConvergenceReport } from "./types";

// Standard SBC benefit-row labels -> representative slug (Path A; Andrew-approved S171). General domain
// vocabulary, NOT GT strings. `note` documents the SBC provenance for each.
const SEED: { label: string; slug: string; note: string }[] = [
  { label: "Rehabilitation services", slug: "pt_rehab", note: "SBC 'Rehabilitation services' row (bundled PT/OT/ST) → macro-tier representative" },
  { label: "Rehabilitative and habilitative services", slug: "pt_rehab", note: "SBC combined rehab/habilitation row → representative" },
  { label: "Hospice services", slug: "hospice_outpatient", note: "SBC 'Hospice services' row" },
  { label: "Physician/surgeon fees (inpatient)", slug: "hospital_admission", note: "SBC hospital-stay 'Physician/surgeon fees' row, inpatient → rolls up to admission" },
];

const sig = (s: string) => normalizeDescriptionSignature(s, "");
const sqlStr = (x: string) => "'" + x.replace(/'/g, "''") + "'"; // Postgres single-quote literal (escape ')
const isScored = (g: GtService) => !g.notFound && g.correctSlug !== null;

function loadArr<T>(path: string | undefined): T[] {
  if (!path) return [];
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return (Array.isArray(raw) ? raw : raw.services ?? []) as T[];
}

function main() {
  const [gtPath, fwdPath, convPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const emit = process.argv.includes("--emit-sql");
  const gt = loadArr<GtService>(gtPath);
  const fwd = new Map(loadArr<ForwardMapEntry>(fwdPath).map((f) => [f.gtId, f]));
  const conv: ConvergenceReport | null = convPath ? JSON.parse(readFileSync(convPath, "utf8")) : null;
  const now = (g: GtService) => fwd.get(g.id)?.resolvedSlug ?? null;
  // rename-awareness (mirrors score.ts canon): an oracle OLD slug (e.g. inpatient_physician) collapses to
  // its live merged target (hospital_admission) via merged_into_id, so a merged-slug correctSlug is the
  // SAME identity as the live target — NOT a collision. Without this the dry-run reports false collisions.
  const rmPath = fwdPath ? join(dirname(fwdPath), "rename-map.json") : undefined;
  const renameMap: Record<string, string> = rmPath && existsSync(rmPath) ? JSON.parse(readFileSync(rmPath, "utf8")) : {};
  if (!Object.keys(renameMap).length) console.warn("⚠ rename-map.json not found — merged-slug renames will read as false collisions.");
  const canon = (x: string | null): string | null => (x == null ? null : (renameMap[x] ?? x));

  // group GT by normalized signature (what the resolver keys Tier-1b on)
  const bySig = new Map<string, GtService[]>();
  for (const g of gt) { const s = sig(g.serviceName); const a = bySig.get(s); if (a) a.push(g); else bySig.set(s, [g]); }

  const coveredIds = new Set<string>();
  let totB1 = 0, totB2 = 0, totColl = 0, totOver = 0;

  console.log(`=== mig 154 re-map DRY-RUN — ${SEED.length} standard-SBC-label seeds vs GT (${gt.length} entries) ===`);
  for (const seed of SEED) {
    const s = sig(seed.label);
    const matched = bySig.get(s) ?? [];
    const okTarget = (g: GtService) => canon(g.correctSlug) === seed.slug || (g.acceptableSlugs ?? []).some((a) => canon(a) === seed.slug);
    // COLLISION: a SCORED entry whose correct answer is NOT this seed's slug but shares the signature →
    // the deterministic seed would REGRESS it. Must be 0 to ship the seed.
    const collisions = matched.filter((g) => isScored(g) && !okTarget(g));
    // OVER-MAP: a NO_CONCEPT entry (should stay null) the seed would force-map → false positive. Must be 0.
    const overMap = matched.filter((g) => !g.notFound && g.correctSlug === null);
    // FIX (B1): a scored entry, correct target, currently UNRESOLVED (null) → seed makes it a recall hit.
    const b1fix = matched.filter((g) => isScored(g) && okTarget(g) && now(g) === null);
    // FIX (B2): an ANDREW scored entry, correct target, currently resolving to a WRONG non-null slug → precision gain.
    const isWrongNow = (g: GtService) => { const r = canon(now(g)); return r !== null && r !== canon(g.correctSlug) && !(g.acceptableSlugs ?? []).some((a) => canon(a) === r); };
    const b2fix = matched.filter((g) => g.adjudicationStatus === "andrew" && isScored(g) && okTarget(g) && isWrongNow(g) && now(g) !== seed.slug);
    matched.forEach((g) => coveredIds.add(g.id));
    totB1 += b1fix.length; totB2 += b2fix.length; totColl += collisions.length; totOver += overMap.length;

    console.log(`\n▸ "${seed.label}" → ${seed.slug}`);
    console.log(`    signature        : "${s}"`);
    console.log(`    GT entries shared: ${matched.length}  (intended target: ${matched.filter(okTarget).length})`);
    console.log(`    B1 fix (null→hit): ${b1fix.length}   B2 fix (wrong→right): ${b2fix.length}`);
    console.log(`    COLLISIONS       : ${collisions.length}${collisions.length ? "  ⚠ " + collisions.map((c) => `"${c.serviceName}"→${c.correctSlug}`).join("; ") : "  ✓"}`);
    console.log(`    no-concept over-map: ${overMap.length}${overMap.length ? "  ⚠ " + overMap.map((c) => `"${c.serviceName}"`).join("; ") : "  ✓"}`);
    const samp = matched.slice(0, 4).map((g) => `"${g.serviceName}"[${g.adjudicationStatus[0]}|correct=${g.correctSlug}|now=${now(g) ?? "∅"}]`);
    if (samp.length) console.log(`    sample           : ${samp.join("  ·  ")}`);
  }

  // ── projection (data proof) ──
  const b1d = gt.filter(isScored).length;
  const b1h = gt.filter((g) => isScored(g) && now(g) !== null).length;
  console.log(`\n=== PROJECTED EFFECT (data proof) ===`);
  console.log(`  collisions (correct→incorrect, MUST be 0 to ship): ${totColl}`);
  console.log(`  no-concept over-map (MUST be 0):                   ${totOver}`);
  console.log(`  B1 recall: ${b1h}/${b1d} = ${(100 * b1h / b1d).toFixed(2)}%  →  ${b1h + totB1}/${b1d} = ${(100 * (b1h + totB1) / b1d).toFixed(2)}%   (floor ≥97.0% → need ≥${Math.ceil(0.97 * b1d)})`);
  console.log(`  B2 precision gains (andrew wrong→right): +${totB2}`);

  // ── residual noise SEPARATION: flippy entries (from convergence) the seed does NOT cover. These stay
  // Haiku-resolved + quarantined (estimate tier / needsReview → workbench); never promoted as truth. ──
  if (conv) {
    const fragileUncovered = conv.fragileAndrewSample.filter((f) => !coveredIds.has(f.gtId));
    console.log(`\n=== RESIDUAL NOISE (separated; NOT corrupted/promoted) ===`);
    console.log(`  convergence: ${conv.unstableAndrew} unstable + ${conv.fragileAndrew} fragile (andrew). Seed covers the standard-label class;`);
    console.log(`  the following fragile-andrew entries remain Haiku-resolved (quarantine/workbench, NOT seeded):`);
    if (!fragileUncovered.length) console.log(`    (none in the fragile sample — the seed covers the fragile class)`);
    for (const f of fragileUncovered) console.log(`    - "${f.serviceName}" → winner ${f.winner ?? "∅"}  votes ${JSON.stringify(f.votes)}`);
  }

  if (emit) {
    console.log(`\n-- ===== mig 154 INSERTs (signatures computed via the REAL normalizer) ===== --`);
    for (const seed of SEED) {
      console.log(`INSERT INTO billing_code_mappings (billing_code, billing_code_type, description_signature, service_slug, confidence, observation_count, provider_descriptions, source)`);
      console.log(`  VALUES (NULL, NULL, ${sqlStr(sig(seed.label))}, ${sqlStr(seed.slug)}, 0.95, 1, '{}', 'thesaurus_remap')  -- ${seed.label}`);
      console.log(`  ON CONFLICT DO NOTHING;`);
    }
  }
}
main();
