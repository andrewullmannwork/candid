/**
 * Ing-G.2a — programmatic synthetic SBCs via pdf-lib (Axis B: direct-PDF generation, a
 * distinct adversary class → Producer "pdf-lib ..."). No browser engine; no install
 * (pdf-lib ships with candid). Parameterized fictional content (Axis A: claude-programmatic).
 *
 * Varies insurer/tier/values/structure + OMB control number (correct 0938-1146 / wrong / absent)
 * so the corpus exercises the structural (G.3) signal independently of the artifact (G.2b) signal.
 *
 * Run: npx tsx scripts/calibration/adversarial/gen-programmatic.ts [--count 20]
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

const DIR = resolve(process.cwd(), "scripts/calibration/adversarial");
const OUT = join(DIR, "_synthetic_pdfs");

const INSURERS = ["Meridian Mutual", "Cascade Crest", "Granite Ridge", "Harbor Point", "Sterling Vale",
  "Cedar Hollow", "Brightwater", "Ironwood", "Lakeshore", "Summit Pines", "Verdant", "Northstar"];
const TIERS = ["Bronze", "Silver", "Gold", "Platinum"];
const TYPES = ["HMO", "PPO", "EPO", "POS"];
const STATES = ["TX", "FL", "CA", "OH", "NC", "AZ", "GA", "WA", "CO", "MI", "OR", "VA"];

// deterministic per-index pseudo-random (no Math.random → reproducible)
function rng(i: number, salt: number) { const x = Math.sin((i + 1) * 99.13 + salt * 7.7) * 10000; return x - Math.floor(x); }
function pick<T>(arr: T[], i: number, salt: number): T { return arr[Math.floor(rng(i, salt) * arr.length)]; }
const money = (i: number, salt: number, lo: number, hi: number) => `$${(Math.round((lo + rng(i, salt) * (hi - lo)) / 50) * 50).toLocaleString()}`;

async function genOne(i: number): Promise<{ omb: string }> {
  const insurer = pick(INSURERS, i, 1), tier = pick(TIERS, i, 2), type = pick(TYPES, i, 3), state = pick(STATES, i, 4);
  const ded = money(i, 5, 500, 8000), oop = money(i, 6, 5000, 9500);
  const ombKind = i % 3 === 0 ? "correct" : i % 3 === 1 ? "wrong" : "absent";
  const ombLine = ombKind === "correct" ? "OMB Control Number: 0938-1146"
    : ombKind === "wrong" ? `OMB Control Number: 0938-${1000 + (i % 9000)}` : "";

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([612, 792]);
  let y = 760;
  const M = 48;
  const line = (t: string, f = font, size = 10, dy = 14) => {
    if (y < M) { page = doc.addPage([612, 792]); y = 760; }
    page.drawText(t, { x: M, y, size, font: f, color: rgb(0, 0, 0) });
    y -= dy;
  };

  line("Summary of Benefits and Coverage: What this Plan Covers & What You Pay for Covered Services", bold, 11, 20);
  line(`Insurer: ${insurer} Health Plan   |   Plan: ${insurer} ${tier} ${type}   |   State: ${state}`, font, 9);
  line(`Coverage Period: 01/01/2026 - 12/31/2026   |   Coverage for: Individual/Family   |   Plan Type: ${type}`, font, 9, 22);

  line("Important Questions", bold, 11, 16);
  line(`What is the overall deductible?   ${ded} Individual`, font, 9);
  line(`What is the out-of-pocket limit for this plan?   ${oop} Individual`, font, 9);
  line(`Will you pay less if you use a network provider?   Yes.`, font, 9);
  line(`Do you need a referral to see a specialist?   ${type === "HMO" ? "Yes." : "No."}`, font, 9, 22);

  line("Common Medical Event / Services You May Need / What You Will Pay / Limitations", bold, 10, 16);
  const svcs: [string, string][] = [
    ["Primary care visit", `$${20 + (i % 4) * 5} copay`],
    ["Specialist visit", `$${50 + (i % 5) * 10} copay`],
    ["Preventive care/screening/immunization", "No charge"],
    ["Diagnostic test (x-ray, blood work)", `${10 + (i % 4) * 5}% coinsurance`],
    ["Imaging (CT/PET scans, MRIs)", `${15 + (i % 3) * 5}% coinsurance`],
    ["Generic drugs", `$${10 + (i % 3) * 5} copay`],
    ["Specialty drugs", `${20 + (i % 4) * 5}% coinsurance`],
    ["Emergency room care", `$${250 + (i % 4) * 50} copay`],
    ["Hospital facility fee", `${15 + (i % 3) * 5}% coinsurance`],
    ["Outpatient mental health", `$${20 + (i % 3) * 10} copay`],
    ["Pregnancy / delivery", `${15 + (i % 3) * 5}% coinsurance`],
  ];
  for (const [s, c] of svcs) line(`  ${s}  —  ${c}`, font, 9, 12);

  // some include coverage examples (structural completeness varies)
  if (i % 2 === 0) {
    y -= 8;
    line("About these Coverage Examples", bold, 10, 14);
    line("Peg is Having a Baby — Total Example Cost $12,800; the total Peg would pay $4,500", font, 9, 12);
    line("Managing Joe's Type 2 Diabetes — Total Example Cost $5,600; the total Joe would pay $1,200", font, 9, 12);
    line("Mia's Simple Fracture — Total Example Cost $2,800; the total Mia would pay $2,500", font, 9, 12);
  }
  y -= 10;
  if (ombLine) line(`Paperwork Reduction Act Statement. ${ombLine}`, font, 8, 10);
  line("Fictional document generated for detector-training purposes. Not a real insurer, plan, or filing.", font, 8, 10);

  const bytes = await doc.save();
  const name = `prog-${String(i).padStart(2, "0")}-${insurer.toLowerCase().replace(/\s+/g, "-")}-${tier.toLowerCase()}-${type.toLowerCase()}`;
  writeFileSync(join(OUT, `${name}.pdf`), bytes);
  writeFileSync(join(OUT, `${name}.meta.json`), JSON.stringify({
    stratum: "synthetic", axis_a_content: "claude-programmatic", axis_b_renderer: "pdf-lib",
    producer_expected: "pdf-lib", fidelity: "programmatic", omb: ombKind,
  }, null, 2));
  return { omb: ombKind };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const count = Number(process.argv[process.argv.indexOf("--count") + 1]) || 20;
  const ombTally: Record<string, number> = {};
  for (let i = 0; i < count; i++) { const r = await genOne(i); ombTally[r.omb] = (ombTally[r.omb] ?? 0) + 1; }
  console.log(`generated ${count} programmatic synthetic SBCs (pdf-lib) → _synthetic_pdfs/`);
  console.log(`OMB distribution: ${JSON.stringify(ombTally)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
