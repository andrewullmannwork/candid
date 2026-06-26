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

// item 5 (S230, Andrew-approved) — drug FORMULARY tier (plan_tier_label) + baked-slug cleanup.
// The catalog already merged the baked _tierN/_90day slugs → clean descriptors (mig 148) and the live
// resolver only emits clean ones; this un-bakes the STALE answer key to match + migrates the encoded
// tier into plan_tier_label. (a2b §8; canon-equivalent for the scorer → B1/B2 provably 0.0 movement.)
const BAKED_TO_CLEAN: Record<string, string> = {
  generic_rx_tier1: "generic_rx",
  generic_rx_tier1_90day: "generic_rx",
  preferred_brand_rx_tier2: "preferred_brand_rx",
  preferred_brand_rx_90day: "preferred_brand_rx",
  non_preferred_rx_tier3: "non_preferred_brand_rx",
  non_preferred_rx_90day: "non_preferred_brand_rx",
  specialty_rx_tier4: "specialty_rx",
  specialty_rx_tier5: "non_preferred_specialty_rx",
};
// The tier baked into a prior-adjudication slug — an INDEPENDENT source from the serviceName text → the
// cross-check that makes the (otherwise text-shared) tier metric non-tautological. _90day-only → none.
const suffixTier = (slug: string): string | undefined => {
  const m = slug.match(/_tier(\d{1,2})\b/);
  return m ? `tier_${m[1]}` : undefined;
};
// GT tier = the tier STATED IN THE TEXT (Rule #17 — never infer one the text omits). Deliberately a
// SEPARATE implementation from the resolver's derivePlanTierLabel so recall/over-fire measure agreement
// of two independent extractors, not a tautology.
const DRUG_CTX = /\b(drugs?|rx|pharmacy|prescriptions?|formulary|medications?|anticancer|chemo\w*|insulin|contracepti\w*|biologic\w*|infusion)\b/;
function gtTextTier(name: string): string | undefined {
  const s = lc(name);
  if (!DRUG_CTX.test(s)) return undefined;
  if ((s.match(/tier\s*\d+/g) || []).length >= 2) return undefined; // multiple tiers → agnostic
  if (/tier\s*\d+\s*[/,&–-]\s*\d/.test(s)) return undefined; // "tier 1/2/4"
  const m = s.match(/tier\s*(\d{1,2})(?!\d)/); // letter sub-tier "1a"→tier_1; reject 3-digit junk
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 12 ? `tier_${n}` : undefined;
}
// The 4 suffix≠text edges (Andrew-ratified S230): slug = descriptor from the text, tier = text tier.
// (18350hi#23 / 29698mi#11 = non-preferred specialty @ Tier 5 → precision wins; 19898fl#6/#8 = this
// plan's own tier numbering, descriptor-canon unchanged.)
const EDGE_RESOLUTION: Record<string, { correctSlug: string; planTierLabel: string }> = {
  "18350hi0880001#23": { correctSlug: "non_preferred_specialty_rx", planTierLabel: "tier_5" },
  "29698mi0540597#11": { correctSlug: "non_preferred_specialty_rx", planTierLabel: "tier_5" },
  "19898fl0340001#6": { correctSlug: "preferred_brand_rx", planTierLabel: "tier_3" },
  "19898fl0340001#8": { correctSlug: "specialty_rx", planTierLabel: "tier_5" },
};

const tup = (slug: string, component: Tuple["component"], place: string): Tuple => ({ slug, placeOfService: place, component });
const MIXED: Tuple[] = [tup("surgery", "professional", "inpatient_facility"), tup("hospital_admission", "professional", "inpatient_facility")];

type Action = { cat: string; correctSlug?: string | null; acceptable?: string[]; multiLabel?: Tuple[]; isPreventiveEligible?: boolean; planTierLabel?: string; note?: string; mutate: boolean };
function decide(g: GtRow): Action | null {
  const name = g.serviceName || "";
  // item 6: a NAMED bone-density / DEXA screening is preventive-eligible (GT flag truth; slug untouched —
  // it stays advanced_imaging / preventive_care; the flag is what lets a non-preventive slug carry $0).
  if (isBoneDensity(name)) return { cat: "preventive-bone-density", isPreventiveEligible: true, mutate: true };
  // item 7 — compound oncology-OPD bundle (radiation + chemotherapy in one cost-share) → multiLabel SET,
  // mirroring the resolver's compound emission. correctSlug stays null (no single primary; the resolver
  // already returns null here, so no over-map). Standalone "Radiation therapy" rows → radiation_therapy
  // are QUEUED for the phase-end N=9 (the slug is brand-new → the frozen forward can't map them yet).
  if (/radiation/.test(lc(name)) && /chemotherapy/.test(lc(name))) {
    const place = /outpatient/.test(lc(name)) ? "outpatient_facility" : "any";
    const set: Tuple[] = [];
    if (/illness|injury|treatment|visit|office/.test(lc(name))) set.push(tup("specialist_visit", "global", place));
    set.push(tup("chemotherapy_rx", "global", place));
    set.push(tup("radiation_therapy", "global", place));
    return { cat: "compound-onco-opd", multiLabel: set, note: `null → multiLabel[${set.map((t) => t.slug).join(",")}] @ ${place}`, mutate: true };
  }
  // item 5 — drug FORMULARY tier + baked-slug cleanup. A drug row (baked descriptor slug OR a drug-context
  // text tier) is mutually exclusive with the surgery/transplant logic below, so handle + return here.
  {
    const baked = g.correctSlug ? BAKED_TO_CLEAN[g.correctSlug] : undefined; // clean descriptor, or undefined
    const textTier = gtTextTier(name); // tier_N from the TEXT (resolver basis), or undefined
    const sTier = g.correctSlug ? suffixTier(g.correctSlug) : undefined; // tier_N from the baked suffix, or undefined
    if (baked || textTier) {
      // suffix (independent prior adjudication) disagrees with the text tier → likely a mis-keyed slug
      // (e.g. a Tier-5 row baked as specialty_rx_tier4). Surface for Andrew; never auto-mutate.
      if (sTier && textTier && sTier !== textTier) {
        const r = EDGE_RESOLUTION[g.id];
        if (r) return { cat: "EDGE-resolved (Andrew S230)", correctSlug: r.correctSlug, planTierLabel: r.planTierLabel, note: `${g.correctSlug} → ${r.correctSlug} · tier=${r.planTierLabel} (suffix ${sTier}, text ${textTier})`, mutate: true };
        return { cat: "EDGE: tier suffix≠text (UNRESOLVED)", planTierLabel: textTier, note: `${g.correctSlug} (suffix ${sTier}) vs text ${textTier} → ADJUDICATE slug+tier`, mutate: false };
      }
      return {
        cat: baked ? "drug-tier-clean (baked→descriptor)" : "drug-tier (orthogonal slug kept)",
        correctSlug: baked, // undefined for non-baked rows → loop leaves correctSlug as-is
        planTierLabel: textTier, // tier from text; undefined → GT stays 'none'
        note: `${g.correctSlug}${baked ? " → " + baked : ""} · tier=${textTier ?? "none"}${sTier ? " [suffix " + sTier + "]" : ""}`,
        mutate: true,
      };
    }
  }
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

const byCat: Record<string, { g: GtRow; a: Action }[]> = {};
let mutated = 0;
// item 5 — independent suffix cross-check (the non-circular tier signal): of rows where BOTH the baked
// suffix and the serviceName text state a tier, how many agree? Disagreements are the EDGE rows.
let suffixBoth = 0, suffixAgree = 0;
for (const g of gt) {
  const a = decide(g);
  if (!a) continue;
  (byCat[a.cat] ??= []).push({ g, a });
  const sT = g.correctSlug ? suffixTier(g.correctSlug) : undefined;
  const tT = gtTextTier(g.serviceName || "");
  if (sT && tT) { suffixBoth++; if (sT === tT) suffixAgree++; }
  if (a.mutate && apply) {
    if (a.correctSlug !== undefined) g.correctSlug = a.correctSlug;
    if (a.acceptable) g.acceptableSlugs = a.acceptable;
    if (a.multiLabel) g.multiLabel = a.multiLabel;
    if (a.isPreventiveEligible !== undefined) g.isPreventiveEligible = a.isPreventiveEligible;
    if (a.planTierLabel) g.planTierLabel = a.planTierLabel;
    mutated++;
  } else if (a.mutate) mutated++;
}

const t = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s).padEnd(w);
for (const [cat, rows] of Object.entries(byCat).sort()) {
  console.log(`\n=== ${cat} — ${rows.length} ===`);
  for (const { g, a } of rows.slice(0, 60))
    console.log(`  ${t(g.id, 18)} ${t(g.adjudicationStatus, 6)} ${t(g.serviceName, 50)} ${a.note ?? "cur=" + g.correctSlug}`);
  if (rows.length > 60) console.log(`  … +${rows.length - 60} more`);
}
console.log(`\n=== SUMMARY ===`);
for (const [cat, rows] of Object.entries(byCat).sort()) console.log(`  ${cat}: ${rows.length}`);
console.log(`\nitem 5 suffix cross-check (independent of the text extractor): ${suffixAgree}/${suffixBoth} rows where baked-suffix tier == text tier`);
console.log(`rows to mutate: ${mutated}  ·  mode: ${apply ? "APPLIED → " + gtPath : "DRY-RUN (no writes)"}`);
if (apply) writeFileSync(gtPath, JSON.stringify(gt, null, 2));
