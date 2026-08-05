/**
 * case-file — S305. The Case File's three load-bearing rules.
 *
 *   1. No data, no section — and the numbering closes up behind it.
 *   2. Anonymity: nothing countable, no thresholds, in EITHER artifact.
 *   3. Adjudication is BANDED, never rated — a percentage IS the sub-count when
 *      the sample is small (60% reads back as three of five to anyone who knows
 *      the sample size), so the bands are what remove the arithmetic.
 *
 * Rule 2 is enforced as a SOURCE guard, not a rendered-output check. The values
 * that would leak (a sample size, a paid/total pair) only exist when there is
 * community data, which a synthetic package cannot conjure — so an output scan
 * would pass vacuously and stay green while someone re-added the string. The
 * guard reads the modules that build user-facing text and fails on the shapes
 * themselves, which is the check that cannot go quietly vacuous.
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/case-file.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { adjudicationBand } from "../../../../src/lib/care/interface";
import {
  sec,
  numberSections,
  formatEvidencePackageAsText,
  type EvidenceSection,
  type EvidencePackage,
} from "../../../../src/lib/legal/evidence-compiler";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

// ── 1 · No data, no section ─────────────────────────────────────────────────
{
  check("a section with content survives", sec("k", "T", "body") !== null);
  check("empty string → omitted", sec("k", "T", "") === null);
  check("whitespace only → omitted", sec("k", "T", "   \n  ") === null);
  check("empty array → omitted", sec("k", "T", []) === null);
  check("array of empties → omitted", sec("k", "T", ["", "", ""]) === null);
  check("array with one real line survives", sec("k", "T", ["", "x", ""]) !== null);

  // The opening line keeps its indentation — `.trim()` on the whole block ate
  // it, so the first row of every section hung left of the rest.
  const s = sec("k", "T", "  first\n  second");
  check("leading indentation of the first line is preserved", s?.content.startsWith("  first") === true, s?.content.slice(0, 8));

  // Identity is not position. The PDF used to branch on `title.startsWith("1.")`
  // and silently discarded the content when the document renumbered.
  check("a section carries a stable key", sec("at_a_glance", "At a glance", "x")?.key === "at_a_glance");
}

// ── 1b · Numbering closes up behind an omission ─────────────────────────────
{
  const drafted: Array<EvidenceSection | null> = [
    sec("a", "At a glance", "x"),
    null, // e.g. Deadlines, when no letter carries one
    sec("c", "The bill", "y"),
    null, // e.g. Comparable, when there is no community data
    sec("e", "Exhibits", "z"),
  ];
  const out = numberSections(drafted);
  check("omitted sections are dropped", out.length === 3, out.length);
  check(
    "the survivors number 1..N with no holes",
    out.map((s) => s.title).join(" | ") === "1. At a glance | 2. The bill | 3. Exhibits",
    out.map((s) => s.title),
  );
  check("keys are untouched by numbering", out.map((s) => s.key).join(",") === "a,c,e");
  check("everything omitted → an empty document, not a hole", numberSections([null, null]).length === 0);
}

// ── 2 · Adjudication is banded, never rated ────────────────────────────────
{
  check("clearly paid → commonly paid", adjudicationBand(8, 10) === "commonly paid");
  check("exactly two-thirds → commonly paid (boundary)", adjudicationBand(2, 3) === "commonly paid");
  check("just under two-thirds → not 'commonly paid'", adjudicationBand(65, 100) !== "commonly paid");
  check("clearly denied → frequently denied", adjudicationBand(1, 10) === "frequently denied");
  check("exactly one-third → frequently denied (boundary)", adjudicationBand(1, 3) === "frequently denied");
  check("just over one-third → not 'frequently denied'", adjudicationBand(35, 100) !== "frequently denied");

  // A genuinely mixed record tells a lawyer nothing and invites an attack on an
  // exhibit that cannot be audited. Silence is the right answer.
  check("mixed → nothing is said", adjudicationBand(5, 10) === null);
  check("no sample → nothing is said", adjudicationBand(0, 0) === null);

  // The band is a WORD. If this ever returns a number the disclosure rule is gone.
  for (const [p, t] of [[8, 10], [1, 10], [2, 3], [1, 3]] as Array<[number, number]>) {
    const b = adjudicationBand(p, t);
    check(`band(${p}/${t}) carries no digit`, b == null || !/\d/.test(b), b);
  }
}

// ── 3 · Nothing countable reaches a user-facing artifact ────────────────────
//
// Source guard. These modules build the text a provider, an insurer or a lawyer
// reads; none of them may print a sample size, a raw paid/total pair, or an
// internal threshold.
{
  const GUARDED = [
    "src/lib/legal/evidence-compiler.ts",
    "src/lib/disputes/templates.ts",
  ];
  // Each pattern is a SHAPE that leaks, with the string that motivated it.
  const BANNED: Array<{ re: RegExp; why: string }> = [
    { re: /\$\{[^}]*\bsampleSize\b[^}]*\}/, why: `"across 5 anonymized Candid-member reports"` },
    { re: /\(n=\$\{/, why: `"(n=5)"` },
    { re: /\$\{[^}]*\bpaidCount\b[^}]*\}/, why: `"3 of 5 community claims paid"` },
    { re: /\$\{[^}]*\btotalClaims\b[^}]*\}/, why: `the denominator of the same` },
    { re: /\$\{[^}]*\bdeniedCount\b[^}]*\}/, why: `"(2 denied)"` },
    { re: /\$\{[^}]*\bsystemic_user_count\b[^}]*\}/, why: `"2 members affected" — never k-anon gated` },
    { re: /\$\{[^}]*K_ANON[^}]*\}/, why: `the threshold itself` },
  ];
  for (const rel of GUARDED) {
    const src = readFileSync(resolve(__dirname, "../../../../", rel), "utf8");
    for (const { re, why } of BANNED) {
      check(`${rel.split("/").pop()} never interpolates ${re.source} — ${why}`, !re.test(src));
    }
  }
}

// ── 4 · The text renderer emits every section it is given ──────────────────
{
  const pkg: EvidencePackage = {
    title: "Candid Case File — Claim deadbeef",
    generatedAt: "2026-08-05T00:00:00.000Z",
    masterDisclaimer: "disclaimer",
    sections: numberSections([sec("a", "At a glance", "  alpha"), sec("b", "Exhibits", "  bravo")]),
  } as EvidencePackage;
  const text = formatEvidencePackageAsText(pkg);
  check("renders each section's title", text.includes("1. At a glance") && text.includes("2. Exhibits"));
  check("renders each section's content", text.includes("alpha") && text.includes("bravo"));
  check("the document is titled a Case File, not an Evidence Package", !text.includes("Evidence Package —"));
}

console.log(`\ncase-file fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
