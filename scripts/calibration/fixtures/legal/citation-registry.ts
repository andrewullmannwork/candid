/**
 * citation-registry — S325 (PR-A, C2). The citation sync guard.
 *
 * THE CONTRACT: a citation-shaped string (§-form, U.S.C./CFR form, Public Law,
 * RCW/WAC) may appear in a letter-emitting module ONLY if its exact text is
 * covered by a CITATION_REGISTRY entry — each entry carrying a verified date.
 * Counsel-reviewed sentences keep citations inline (byte-exact prose is the
 * point); the registry is the citations-of-record list and THIS fixture is
 * what stops a wrong-form citation ("ACA §2719" — the S324 find) or an
 * unverified new one from riding into a letter again.
 *
 * Scan scope: string/template LITERALS (via the TypeScript AST — comments are
 * exempt by construction) across src/lib/disputes/** and src/lib/legal/**.
 * Widening the scope (rail copy, timeline copy) is PR-B's forum-menu work.
 *
 * Also locked here:
 *  - BANNED strings: "Department of Insurance" (nonexistent in WA, wrong
 *    agency for ~94% of state-regulated CA commercial members — memo 04),
 *    the "ACA §2719" family, and the C4 recoup clause.
 *  - The two Andrew-approved neutral consequence sentences, byte-exact (R13).
 *  - The C4 posture statics: every catalog ground's disposition matches its
 *    auto letter type's disposition (auto-detection can never route into a
 *    negotiate/validate instrument — those are the USER's deliberate pick),
 *    and the instrument postures are pinned.
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/citation-registry.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

import {
  CITATION_REGISTRY,
  REGISTERED_CITES,
} from "../../../../src/lib/disputes/citation-registry";
import {
  NEUTRAL_INSURER_CONSEQUENCE,
  NEUTRAL_PROVIDER_CONSEQUENCE,
} from "../../../../src/lib/disputes/templates";
import {
  DISPUTE_GROUND_CATALOG,
  LETTER_DISPOSITION,
  deriveFindingToDisposition,
} from "../../../../src/lib/disputes/dispute-ground-catalog";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 1) Collect the scan set
// ---------------------------------------------------------------------------
const ROOT = resolve(__dirname, "../../../../");
const SCAN_DIRS = ["src/lib/disputes", "src/lib/legal"];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
// The registry module itself is exempt: its literals ARE the registry (cites,
// labels, notes — including the "never 'ACA §2719'" warning note). Scanning the
// file that defines the universe is circular.
const files = SCAN_DIRS.flatMap((d) => tsFilesUnder(join(ROOT, d))).filter(
  (f) => !f.endsWith("src/lib/disputes/citation-registry.ts"),
);
check("scan set is non-trivial (≥ 20 files)", files.length >= 20, `got ${files.length}`);

// ---------------------------------------------------------------------------
// 2) Extract string/template literal text per file (comments exempt by AST)
// ---------------------------------------------------------------------------
function literalTexts(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const texts: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      texts.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      texts.push(node.head.text);
      for (const span of node.templateSpans) texts.push(span.literal.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(src);
  return texts;
}

// ---------------------------------------------------------------------------
// 3) The citation shapes + coverage rule
// ---------------------------------------------------------------------------
const CITE_PATTERNS: RegExp[] = [
  // "PHSA §2719", "29 CFR §2560.503-1(h)(2)(iii)", "15 U.S.C. §1692g", bare "§1692e(8)"
  /(?:\b(?:ACA|PHSA|FDCPA|HIPAA|ERISA)\s+)?(?:\b\d+\s+)?(?:U\.?S\.?C\.?|C\.?F\.?R\.?|USC|CFR)?\s?§+\s?[\dA-Za-z][\dA-Za-z().-]*/g,
  /\bPublic Law\s+\d+-\d+/g,
  /\b(?:RCW|WAC)\s+\d[\d.]*/g,
];

/** Strip prose punctuation the regex swallowed: a trailing ')' that has no
 *  matching '(' inside the match belongs to the surrounding sentence
 *  ("(15 U.S.C. §1692g)"), while "§1692e(8)" keeps its balanced paren; and a
 *  citation never ends in sentence punctuation. */
function tidy(raw: string): string {
  let m = raw.trim();
  for (;;) {
    if (/[.,;:]$/.test(m)) { m = m.slice(0, -1); continue; }
    if (m.endsWith(")")) {
      const open = (m.match(/\(/g) ?? []).length;
      const close = (m.match(/\)/g) ?? []).length;
      if (close > open) { m = m.slice(0, -1); continue; }
    }
    break;
  }
  return m;
}

function citationMatches(text: string): string[] {
  const out: string[] = [];
  for (const re of CITE_PATTERNS) {
    for (const m of text.matchAll(re)) out.push(tidy(m[0]));
  }
  return out;
}

const covered = (match: string) => REGISTERED_CITES.some((cite) => cite.includes(match));

let totalMatches = 0;
for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  for (const text of literalTexts(file)) {
    for (const match of citationMatches(text)) {
      totalMatches++;
      check(
        `citation covered: "${match}" (${rel})`,
        covered(match),
        `not covered by any CITATION_REGISTRY cite — register it (with a verified date) or fix the form`,
      );
    }
  }
}
// Denominator guard (S313: a zero-row gate needs a denominator) — an extractor
// bug that finds nothing must FAIL, not pass vacuously.
check("scanner found a real citation population (≥ 15 matches)", totalMatches >= 15, `got ${totalMatches}`);

// ---------------------------------------------------------------------------
// 4) Banned strings (literal scan, same scope)
// ---------------------------------------------------------------------------
const BANNED = [
  "Department of Insurance",
  "ACA §2719",
  "ACA Section 2719",
  "Affordable Care Act Section 2719",
  "investigate and recoup",
];
for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  const all = literalTexts(file).join("\n");
  for (const banned of BANNED) {
    check(`banned string absent: "${banned}" (${rel})`, !all.includes(banned));
  }
}

// ---------------------------------------------------------------------------
// 5) The approved neutral consequence sentences, byte-exact (R13)
// ---------------------------------------------------------------------------
check(
  "neutral insurer consequence is the approved sentence",
  NEUTRAL_INSURER_CONSEQUENCE ===
    " If this matter is not resolved, I intend to pursue external review under PHSA §2719 (42 U.S.C. §300gg-19) and the regulatory complaint avenues available to me.",
);
check(
  "neutral provider consequence is the approved sentence",
  NEUTRAL_PROVIDER_CONSEQUENCE ===
    " If this matter is not resolved, I may file a complaint with my state's consumer-protection authority and, where applicable, the federal No Surprises Help Desk.",
);

// ---------------------------------------------------------------------------
// 6) Registry hygiene
// ---------------------------------------------------------------------------
const cites = new Set<string>();
for (const [id, entry] of Object.entries(CITATION_REGISTRY)) {
  check(`entry ${id}: verified date is YYYY-MM-DD`, /^\d{4}-\d{2}-\d{2}$/.test(entry.verified));
  check(`entry ${id}: cite + label non-empty`, entry.cite.length > 0 && entry.label.length > 0);
  check(`entry ${id}: cite unique`, !cites.has(entry.cite));
  cites.add(entry.cite);
}

// ---------------------------------------------------------------------------
// 7) C4 posture statics
// ---------------------------------------------------------------------------
for (const [ground, spec] of Object.entries(DISPUTE_GROUND_CATALOG)) {
  check(
    `ground ${ground}: disposition matches its auto letter type's posture`,
    spec.disposition === LETTER_DISPOSITION[spec.autoLetterType],
    `${spec.disposition} vs ${LETTER_DISPOSITION[spec.autoLetterType]} (${spec.autoLetterType})`,
  );
}
check("negotiation instrument posture pinned", LETTER_DISPOSITION.negotiation === "negotiate");
check("debt_validation instrument posture pinned", LETTER_DISPOSITION.debt_validation === "validate");
check(
  "auto-routing can never reach a non-correct instrument",
  Object.values(DISPUTE_GROUND_CATALOG).every(
    (s) => LETTER_DISPOSITION[s.autoLetterType] === "correct",
  ),
);
check(
  "finding→disposition projection yields only declared postures",
  Object.values(deriveFindingToDisposition()).every((d) => d === "correct"),
  "a postured ground was added — wire its instrument deliberately, never via auto-routing",
);

// ---------------------------------------------------------------------------
console.log(`\ncitation-registry fixture: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
