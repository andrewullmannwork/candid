/**
 * A2b Phase 2 — GT reconciliation (Andrew-ratified, S226).
 *
 * SCOPE (this session — the surgeon-fee component LEAD + transplant; NOT the broad stale-null pass):
 *   1. INPATIENT physician/surgeon MIXED umbrella ("physician/surgeon fees", both named)
 *        → multiLabel { surgery·professional·inpatient_facility , hospital_admission·professional·inpatient_facility }
 *          + acceptableSlugs ∪ {surgery, hospital_admission}.  correctSlug left as-is (canon-stable).
 *   2. pure SURGEON inpatient ("Surgeon fee", no physician word) → correctSlug surgery + tuple surgery·professional·inpatient.
 *   3. pure PHYSICIAN inpatient ("Physician visits", no surgeon) → NOT mutated (decode-map: inpatient_physician → hospital_admission·professional).
 *   4. TRANSPLANT (8 rows, currently null) → the live mig-148 `transplant` slug, component/place from wording;
 *        "Transportation and Lodging" → `medical_travel`.
 *   EXCLUDED (left as-is): mental-health/autism/SUD rows.
 *
 * `score.ts` ignores `multiLabel`, so slug-level B1/B2 are unaffected except where correctSlug or acceptableSlugs
 * actually change (the ~5 surgeon strays + the 1 surgeon fix + the 8 transplant rows) — the isolated GT-correction leg.
 *
 * DRY-RUN by default. --apply writes <dir>/gt.json IN PLACE (point only at the Phase-2 dir, never legC).
 *   npx tsx scripts/calibration/thesaurus/phase2-reconcile.ts <gate-dir> [--apply]
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

type Tuple = { slug: string; placeOfService: string; component: "facility" | "professional" | "global" };
type GtRow = {
  id: string; docType: string; adjudicationStatus: string; serviceName: string;
  correctSlug: string | null; acceptableSlugs?: string[] | null; multiLabel?: Tuple[]; isPreventiveEligible?: boolean;
  [k: string]: unknown;
};

const dir = process.argv[2];
const apply = process.argv.includes("--apply");
if (!dir) { console.error("usage: phase2-reconcile.ts <gate-dir> [--apply]"); process.exit(1); }
const gtPath = join(dir, "gt.json");
const gt = JSON.parse(readFileSync(gtPath, "utf8")) as GtRow[];

const lc = (s: string) => (s || "").toLowerCase();
const isMH = (s: string) => /mental|behavioral|behaviour|psych|autism|substance|\bsud\b|chemical depend|addiction/.test(lc(s));
const isTransplant = (s: string) => /transplant/.test(lc(s));
const isFacilityFee = (s: string) => /facility fee|hospital room|room and board/.test(lc(s));
const isTravel = (s: string) => /transport|lodging|travel/.test(lc(s));
const hasFacility = (s: string) => /facility/.test(lc(s));
const hasSurgeon = (s: string) => /surgeon|surgical/.test(lc(s));
const hasPhysician = (s: string) => /physician|doctor|hospitalist|attending/.test(lc(s));
const isInpatient = (s: string) => /inpatient|hospital stay|hospital admission|hospital inpatient/.test(lc(s));
const isPhysicianLine = (s: string) => /(physician|surgeon|doctor)[^.]{0,40}\b(fee|fees|services|visit|visits)\b|surgeon fee/.test(lc(s));
const isOPD = (s: string) => /outpatient department of (?:a |the )?hospital|hospital outpatient|outpatient hospital|\bopd\b/.test(lc(s));
const isASC = (s: string) => /ambulatory surg(?:ery|ical) center|\basc\b|freestanding|surg(?:ery|ical) center/.test(lc(s));
const isBoneDensity = (s: string) => /bone density|bone mineral density|\bdexa\b|osteoporosis screening/.test(lc(s));

const tup = (slug: string, component: Tuple["component"], place: string): Tuple => ({ slug, placeOfService: place, component });
const MIXED: Tuple[] = [tup("surgery", "professional", "inpatient_facility"), tup("hospital_admission", "professional", "inpatient_facility")];

type Action = { cat: string; correctSlug?: string | null; acceptable?: string[]; multiLabel?: Tuple[]; isPreventiveEligible?: boolean; mutate: boolean };
function decide(g: GtRow): Action | null {
  const name = g.serviceName || "";
  // item 6: a NAMED bone-density / DEXA screening is preventive-eligible (GT flag truth; slug untouched —
  // it stays advanced_imaging / preventive_care; the flag is what lets a non-preventive slug carry $0).
  if (isBoneDensity(name)) return { cat: "preventive-bone-density", isPreventiveEligible: true, mutate: true };
  if (isTransplant(name)) {
    if (isTravel(name)) return { cat: "transplant→travel", correctSlug: "medical_travel", multiLabel: [tup("medical_travel", "global", "any")], mutate: true };
    if (hasFacility(name)) return { cat: "transplant·facility", correctSlug: "transplant", multiLabel: [tup("transplant", "facility", "inpatient_facility")], mutate: true };
    if (hasPhysician(name) || hasSurgeon(name)) return { cat: "transplant·professional", correctSlug: "transplant", multiLabel: [tup("transplant", "professional", "inpatient_facility")], mutate: true };
    return { cat: "transplant·global", correctSlug: "transplant", multiLabel: [tup("transplant", "global", "any")], mutate: true };
  }
  // BUCKET-A + D3 (S228, Andrew-ratified) — outpatient-surgery rows keyed to the FACILITY decode-slug:
  if (g.correctSlug === "outpatient_surgery_facility") {
    // BUCKET-A: a PHYSICIAN-component line mis-keyed as facility → re-key to the physician decode-slug.
    // score.ts canons BOTH decode-keys (outpatient_surgery_facility / _physician) → "surgery", so slug
    // B1/B2 are byte-unchanged; only the tuple decode (component/place) flips facility→professional.
    if (isPhysicianLine(name) && !isASC(name))
      return { cat: "bucketA-outpt-physician", correctSlug: "outpatient_surgery_physician", mutate: true };
    // D3: a hospital OUTPATIENT-DEPARTMENT surgery line ≠ a freestanding ASC (different CMS POS + cost-
    // share). The decode maps the slug uniformly to independent_facility; override place→outpatient_facility
    // per-row via multiLabel (correctSlug untouched → slug-level unchanged; component stays facility).
    if (isOPD(name) && !isASC(name))
      return { cat: "D3-opd→outpatient_facility", multiLabel: [tup("surgery", "facility", "outpatient_facility")], mutate: true };
  }
  if (!isInpatient(name) || isFacilityFee(name)) return null;
  if (!hasSurgeon(name) && !hasPhysician(name)) return null;
  if (isMH(name)) return { cat: "excluded-MH", mutate: false };
  if (hasSurgeon(name) && hasPhysician(name)) {
    const acc = Array.from(new Set([...(g.acceptableSlugs ?? []), "surgery", "hospital_admission"]));
    return { cat: "MIXED", acceptable: acc, multiLabel: MIXED, mutate: true };
  }
  if (hasPhysician(name)) return { cat: "pure-physician (decode-map; no mutate)", mutate: false };
  return { cat: "pure-surgeon", correctSlug: "surgery", multiLabel: [tup("surgery", "professional", "inpatient_facility")], mutate: true };
}

const byCat: Record<string, GtRow[]> = {};
let mutated = 0;
for (const g of gt) {
  const a = decide(g);
  if (!a) continue;
  (byCat[a.cat] ??= []).push(g);
  if (a.mutate && apply) {
    if (a.correctSlug !== undefined) g.correctSlug = a.correctSlug;
    if (a.acceptable) g.acceptableSlugs = a.acceptable;
    if (a.multiLabel) g.multiLabel = a.multiLabel;
    if (a.isPreventiveEligible !== undefined) g.isPreventiveEligible = a.isPreventiveEligible;
    mutated++;
  } else if (a.mutate) mutated++;
}

const t = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s).padEnd(w);
for (const [cat, rows] of Object.entries(byCat).sort()) {
  console.log(`\n=== ${cat} — ${rows.length} ===`);
  for (const g of rows.slice(0, 50))
    console.log(`  ${t(g.id, 18)} ${t(g.adjudicationStatus, 6)} ${t(g.serviceName, 52)} cur=${g.correctSlug}`);
  if (rows.length > 50) console.log(`  … +${rows.length - 50} more`);
}
console.log(`\n=== SUMMARY ===`);
for (const [cat, rows] of Object.entries(byCat).sort()) console.log(`  ${cat}: ${rows.length}`);
console.log(`rows to mutate: ${mutated}  ·  mode: ${apply ? "APPLIED → " + gtPath : "DRY-RUN (no writes)"}`);
if (apply) writeFileSync(gtPath, JSON.stringify(gt, null, 2));
