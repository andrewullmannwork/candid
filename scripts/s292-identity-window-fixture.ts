/* S292 fixture — identity-extraction input window (hermetic: NO network, NO DB).
 * Runnable: npx tsx scripts/s292-identity-window-fixture.ts
 *
 * Locks the input-selection behavior of extractPlanIdentifiersWithHaiku via
 * its pure, exported window function. Background: the historical
 * slice(0, 2000) assumed the plan header sits at offset 0, but federal-layout
 * SBCs open with a standardized ~3,100-char glossary block — DEV doc 534eea3c
 * (PacificSource Core Gold 1500, header at offset 3075) extracted
 * planName/planYear/planType = null and linked to no canonical. The S292
 * corpus measurement (scripts/s292-identity-extraction-corpus.ts, 27 DEV docs,
 * 7 with displaced headers) selected slice(0, 8000); see the comment on
 * IDENTITY_WINDOW_CHARS in src/lib/plan/extraction-dedup.ts.
 *
 * Cases: header at 0 · header past 2,000 (the proven bug) · header past 8,000
 * (the documented bound) · no header · empty · short input · purity/prefix.
 */
import {
  selectIdentityWindow,
  IDENTITY_WINDOW_CHARS,
} from "@/lib/plan/extraction-dedup";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// Synthetic federal SBC header line (shape mirrors the real PacificSource doc;
// no carrier semantics in the assertion — any header text works the same).
const HEADER =
  "Summary of Benefits and Coverage: What this Plan Covers & What You Pay For Covered Services   Coverage Period: 01/01/2026 - 12/31/2026\n" +
  "ExampleCarrier: Core Gold 1500   Coverage for: Individual+Family   Plan Type: EPO\n";

// Standardized glossary-style filler (the block that displaces real headers).
const filler = (n: number): string =>
  "The Summary of Benefits and Coverage (SBC) document will help you choose a health plan. "
    .repeat(Math.ceil(n / 90))
    .slice(0, n);

// ── 1. Header at offset 0 → always inside the window ────────────────────────
{
  const ocr = HEADER + filler(20000);
  const w = selectIdentityWindow(ocr);
  check("1 header at offset 0 is in the window", w.includes("Coverage Period: 01/01/2026"));
  check("1 window is bounded", w.length <= IDENTITY_WINDOW_CHARS, `len=${w.length}`);
}

// ── 2. Header past 2,000 chars — THE proven production bug ──────────────────
// A 3,100-char preamble (max observed federal glossary offset was 3,082)
// evicted the header from the old slice(0, 2000). It must survive now.
{
  const ocr = filler(3100) + HEADER + filler(20000);
  const w = selectIdentityWindow(ocr);
  check("2 header at offset 3100 is in the window (old 2K window missed it)",
    w.includes("Coverage Period: 01/01/2026"));
  check("2 plan-name text at offset >3100 is in the window",
    w.includes("Core Gold 1500"));
  const old2k = ocr.slice(0, 2000);
  check("2 sanity: the OLD 2K window really did exclude this header",
    !old2k.includes("Coverage Period: 01/01/2026"));
}

// ── 3. Header past 8,000 chars — the documented bound ───────────────────────
// KNOWN LIMIT, asserted so the bound is explicit: 0/27 corpus docs had a
// header beyond 8,000. If this case ever appears in the wild, this fixture
// line is the one to renegotiate.
{
  const ocr = filler(9000) + HEADER;
  const w = selectIdentityWindow(ocr);
  check("3 header at offset 9000 is OUTSIDE the window (documented bound)",
    !w.includes("Coverage Period: 01/01/2026"));
  check("3 window equals the 8,000-char head", w === ocr.slice(0, 8000));
}

// ── 4. No header at all (EOC / plan booklet layouts) ────────────────────────
{
  const ocr = filler(30000);
  const w = selectIdentityWindow(ocr);
  check("4 no-header doc → bounded head, nothing invented",
    w === ocr.slice(0, IDENTITY_WINDOW_CHARS) && w.length === IDENTITY_WINDOW_CHARS);
}

// ── 5. Empty + short inputs ──────────────────────────────────────────────────
{
  check("5 empty input → empty window", selectIdentityWindow("") === "");
  const short = filler(120) + HEADER;
  check("5 short input (<8K) passes through whole", selectIdentityWindow(short) === short);
  const exact = filler(IDENTITY_WINDOW_CHARS);
  check("5 exactly-8K input passes through whole",
    selectIdentityWindow(exact) === exact);
}

// ── 6. Purity + prefix contract ──────────────────────────────────────────────
{
  const ocr = filler(2500) + HEADER + filler(12000);
  const w1 = selectIdentityWindow(ocr);
  const w2 = selectIdentityWindow(ocr);
  check("6 deterministic (same input → same output)", w1 === w2);
  check("6 prefix contract: output === input.slice(0, IDENTITY_WINDOW_CHARS)",
    w1 === ocr.slice(0, IDENTITY_WINDOW_CHARS));
  check("6 IDENTITY_WINDOW_CHARS is 8000 (S292 measured winner)",
    IDENTITY_WINDOW_CHARS === 8000, `got ${IDENTITY_WINDOW_CHARS}`);
  check("6 window clears the max observed federal preamble (3,082) with margin",
    IDENTITY_WINDOW_CHARS >= 3082 * 2);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
