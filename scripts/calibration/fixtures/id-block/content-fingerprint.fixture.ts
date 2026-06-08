/**
 * ID-Block content-fingerprint fixture (Ship Gate G4 — security-critical pure fn).
 *
 * Locks the §3.1 TRIGGER's invariants BEFORE the cluster-legitimacy gate ever hooks
 * the live CF-40 promotion path:
 *   - replay (identical normalized text) → Hamming 0 (the actual attack case),
 *   - re-save invariance (whitespace / case / punctuation jitter) → Hamming 0,
 *   - minor single-token OCR noise → small Hamming (graceful, NOT a cliff),
 *   - distinct documents → large Hamming (no false "same document"),
 *   - empty / whitespace-only → null,
 *   - determinism, and malformed/null input → max distance (never "same document").
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/id-block/content-fingerprint.fixture.ts
 *
 * Pass criteria: all cases PASS. Exit 0 on PASS, 1 on any failure.
 */

import {
  ALGO_VERSION,
  computeContentFingerprint,
  hammingDistance,
} from "../../../../src/lib/parser/id-block/content-fingerprint";

// A representative ~60-word SBC paragraph.
const SBC_BASE =
  "This Summary of Benefits and Coverage document explains how you and the plan " +
  "share the cost of covered health care services. The overall deductible is two " +
  "thousand dollars per individual and four thousand dollars per family. After you " +
  "meet the deductible you pay twenty percent coinsurance for most in network " +
  "services until you reach the out of pocket maximum for the plan year.";

// Same document, re-saved: cosmetic whitespace + case + punctuation differences only.
const SBC_RESAVE =
  "  THIS Summary of Benefits   and Coverage document explains how you and the plan " +
  "share the cost of covered health care services!!  The overall deductible is two " +
  "thousand dollars per individual, and four thousand dollars per family. After you " +
  "meet the deductible you pay twenty percent coinsurance for most in-network " +
  "services until you reach the out-of-pocket maximum for the plan year.   ";

// Same document, single-token OCR noise: "coinsurance" → "colnsurance" (i→l).
const SBC_OCR_NOISE = SBC_BASE.replace("coinsurance", "colnsurance");

// A clearly different document (dental).
const DENTAL_DOC =
  "Your dental plan covers two routine cleanings each calendar year at no charge. " +
  "Basic restorative work such as fillings is covered at fifty percent after a " +
  "twenty five dollar copay. Major services including crowns bridges and dentures " +
  "require prior authorization and are subject to an annual maximum benefit limit.";

interface Case {
  name: string;
  run: () => boolean;
  detail?: () => string;
}

const fp = (t: string) => computeContentFingerprint(t);

const cases: Case[] = [
  {
    name: `ALGO_VERSION is pinned at 1`,
    run: () => ALGO_VERSION === 1,
  },
  {
    name: "fingerprint is a 16-char lowercase hex string",
    run: () => /^[0-9a-f]{16}$/.test(fp(SBC_BASE) ?? ""),
    detail: () => `fp=${fp(SBC_BASE)}`,
  },
  {
    name: "identical text → identical fingerprint (Hamming 0)",
    run: () => hammingDistance(fp(SBC_BASE), fp(SBC_BASE)) === 0,
  },
  {
    name: "re-save invariance: whitespace/case/punctuation jitter → Hamming 0 (the replay case)",
    run: () => hammingDistance(fp(SBC_BASE), fp(SBC_RESAVE)) === 0,
    detail: () => `hamming=${hammingDistance(fp(SBC_BASE), fp(SBC_RESAVE))}`,
  },
  {
    name: "minor single-token OCR noise → small Hamming (≤ 12, graceful)",
    run: () => {
      const d = hammingDistance(fp(SBC_BASE), fp(SBC_OCR_NOISE));
      return d > 0 && d <= 12;
    },
    detail: () => `hamming=${hammingDistance(fp(SBC_BASE), fp(SBC_OCR_NOISE))}`,
  },
  {
    name: "distinct documents → large Hamming (≥ 18, no false same-document)",
    run: () => hammingDistance(fp(SBC_BASE), fp(DENTAL_DOC)) >= 18,
    detail: () => `hamming=${hammingDistance(fp(SBC_BASE), fp(DENTAL_DOC))}`,
  },
  {
    name: "OCR-noise distance is far smaller than distinct-doc distance (separation holds)",
    run: () =>
      hammingDistance(fp(SBC_BASE), fp(SBC_OCR_NOISE)) <
      hammingDistance(fp(SBC_BASE), fp(DENTAL_DOC)),
  },
  {
    name: "empty text → null",
    run: () => fp("") === null,
  },
  {
    name: "whitespace/punctuation-only text → null",
    run: () => fp("   \n\t  !!! --- ") === null,
  },
  {
    name: "short text (< shingle size) → deterministic non-null hex",
    run: () => {
      const a = fp("dental plan");
      const b = fp("dental plan");
      return a !== null && a === b && /^[0-9a-f]{16}$/.test(a);
    },
  },
  {
    name: "determinism: recompute over a long doc → equal",
    run: () => fp(SBC_BASE) === fp(SBC_BASE),
  },
  {
    name: "hammingDistance(null, x) → 64 (a parse failure is never 'same document')",
    run: () => hammingDistance(null, fp(SBC_BASE)) === 64,
  },
  {
    name: "hammingDistance malformed hex → 64",
    run: () => hammingDistance("xyz", "0123456789abcdef") === 64,
  },
];

let failed = 0;
for (const c of cases) {
  let ok = false;
  let err = "";
  try {
    ok = c.run();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const extra = c.detail && (!ok || process.env.VERBOSE) ? `  [${c.detail()}]` : "";
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}${extra}${err ? `  (threw: ${err})` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
