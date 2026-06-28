/**
 * Fixture: verifyVisitLimit on the 19-plan corpus + Andrew's adjudication (Fix B).
 *
 * Calibration note: Andrew's "Does not say" applies ONLY to the blank-annualLimit rows, and means
 * "the worksheet hid the cap text from me" — NOT "the cap is absent." So his "Correct" rows (cap text
 * shown) ARE ground truth; his "Does not say" rows are NOT (the OCR is the oracle there).
 *
 * A row is a GROUNDABLE visit cap only if its cap text holds a visit/day/exam UNIT *and* the count
 * (digit or word). A "$150 allowance", "1 pair of glasses" (quantity), or a derived count ("every 6
 * months" → 2) is NOT a verbatim visit limit, so dropping it is CORRECT, not a failure.
 *
 * Hard gates: (1) every GROUNDABLE real cap (Andrew "Correct") is KEPT; (2) every KEPT value's excerpt
 * is verbatim-in-OCR (no hallucination/copay survives). Blank-row keep/null is reported for review.
 *   npx tsx scripts/coldstart-coverage/visit-verifier.fixture.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { verifyVisitLimit } from "@/lib/plan_doc/haiku-prompts/services-cost-sharing";

const DOC =
  process.env.ADJ_DOC ||
  "/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/coverage-dims-adjudication-2026-06-26/referral-adjudication.md";
const OCR =
  process.env.OCR_DIR ||
  "/Users/andrewullmann/Desktop/candid/.claude/worktrees/backend-coldstart-regen/.scratch-coldstart/ocr-cache";

const UNIT = /\b(?:visit|day|treatment|session|trip|night|exam|screening)s?\b/i;
const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
function countInText(n: number, t: string): boolean {
  const a = [String(n)];
  if (n < NUM.length) a.push(NUM[n]);
  if (n === 1) a.push("once");
  if (n === 2) a.push("twice");
  return new RegExp(`\\b(?:${a.join("|")})\\b`, "i").test(t);
}

type Row = { docId: string; slug: string; vl: number; cap: string; anchor: string; verdict: string };
const rows: Row[] = [];
let sec = "";
for (const ln of readFileSync(DOC, "utf8").split("\n")) {
  const h = ln.match(/^## (\d)/);
  if (h) { sec = h[1]; continue; }
  if (sec === "3" && ln.startsWith("| [")) {
    const c = ln.split("|").map((s) => s.trim());
    const id = ln.match(/eq%3A([0-9a-f-]+)\)/)?.[1];
    const vl = parseInt(c[4].replace(/\*/g, ""), 10);
    if (!id || !Number.isFinite(vl)) continue;
    rows.push({ docId: id, slug: c[2].replace(/`/g, ""), vl, cap: c[5] === "—" ? "" : c[5], anchor: c[6] ?? "", verdict: (c[7] ?? "").toLowerCase() });
  }
}

const ocrCache = new Map<string, string>();
const getOcr = (id: string): string => {
  if (!ocrCache.has(id)) { try { ocrCache.set(id, readFileSync(join(OCR, id + ".txt"), "utf8")); } catch { ocrCache.set(id, ""); } }
  return ocrCache.get(id)!;
};
const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

let groundedKept = 0, groundedDropped = 0, nonVisitDropped = 0, blankKept = 0, blankNull = 0, ungrounded = 0, skipped = 0;
const drops: string[] = [], badKeep: string[] = [], blankKeeps: string[] = [];
for (const r of rows) {
  const ocr = getOcr(r.docId);
  if (!ocr) { skipped++; continue; }
  const exc = verifyVisitLimit(r.vl, r.cap || null, r.anchor, ocr);
  const kept = exc !== null;
  if (kept && !norm(ocr).includes(norm(exc!).slice(0, 40))) { ungrounded++; badKeep.push(`  UNGROUNDED-KEEP ${r.slug} vl=${r.vl} exc="${exc}"`); }
  const hasText = !!r.cap.trim();
  if (hasText) {
    const groundable = UNIT.test(r.cap) && countInText(r.vl, r.cap);
    if (kept) groundedKept += groundable ? 1 : 0;
    else if (groundable) { groundedDropped++; drops.push(`  DROPPED-REAL ${r.slug} vl=${r.vl} cap="${r.cap}" (${r.docId.slice(0, 8)})`); }
    else nonVisitDropped += kept ? 0 : 1;
  } else if (kept) { blankKept++; blankKeeps.push(`  blank→KEEP ${r.slug} vl=${r.vl} exc="${exc!.slice(0, 60)}…"`); }
  else blankNull++;
}

console.log(`Visit rows scored: ${rows.length - skipped} (skipped ${skipped})`);
console.log(`\nWITH-text caps (Andrew "Correct" = ground truth):`);
console.log(`  groundable visit caps KEPT:    ${groundedKept}`);
console.log(`  groundable visit caps DROPPED: ${groundedDropped}   ${groundedDropped ? "<- HARD FAILURE" : "✓"}`);
console.log(`  non-visit drops ($/quantity/derived, correct to drop): ${nonVisitDropped}`);
if (drops.length) console.log(drops.join("\n"));
console.log(`\nBLANK caps (OCR oracle — Andrew couldn't see these): KEEP ${blankKept} · null ${blankNull}`);
if (blankKeeps.length) console.log(blankKeeps.join("\n"));
console.log(`\nGrounding: ungrounded keeps (value NOT in OCR) = ${ungrounded}   ${ungrounded ? "<- HARD FAILURE" : "✓"}`);
if (badKeep.length) console.log(badKeep.join("\n"));
process.exit(groundedDropped > 0 || ungrounded > 0 ? 1 : 0);
