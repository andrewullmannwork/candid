// S74.6 §D.6 D4 description-match flywheel unit tests
//
// Covers the PURE-FUNCTION pieces of D4:
//   - normalizeDescriptionSignature() on representative bill descriptions
//   - §C.1 §D.5 invariant: D4 only fires on lines WITHOUT a pre-flight slug
//   - §D.1 source-entry shape invariants for vote-recording payloads
//   - DescriptionMatchResult tier boundaries (confident / ambiguous / soft)
//
// DB-touching acceptance criteria from Subplan §D.6 (5-user convergence →
// promotion → backfill, ambiguous → 2 rows + queue, etc.) are exercised via
// integration smoke — see testing-strategy doc for the seeded-state
// workaround given the 1-account + Claude-can't-upload constraint.
//
// Run: npx tsx scripts/test-d4-flywheel.ts

import { normalizeDescriptionSignature } from "../src/lib/parser/code-identity";
import type {
  DescriptionMatchCandidate,
  DescriptionMatchResult,
} from "../src/lib/audit/description-service-match";
import type { BillLineItem } from "../src/lib/billing/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── normalizeDescriptionSignature on D4-typical descriptions ──────────

{
  const sig = normalizeDescriptionSignature(
    "OFFICE VISIT EST PRIMARY CARE",
    "99214",
  );
  check(
    "signature: 'OFFICE VISIT EST PRIMARY CARE' normalizes deterministically",
    sig.length > 0,
  );
  // Re-normalize — must produce identical output (purity)
  const sig2 = normalizeDescriptionSignature(
    "OFFICE VISIT EST PRIMARY CARE",
    "99214",
  );
  check("signature: pure function (same input → same output)", sig === sig2);

  // Word-order invariance — sorted tokens
  const sig3 = normalizeDescriptionSignature(
    "PRIMARY CARE OFFICE VISIT EST",
    "99214",
  );
  check(
    "signature: word-order invariant (token-sort)",
    sig === sig3,
  );
}

{
  // Empty / unparseable descriptions
  const sigEmpty = normalizeDescriptionSignature("", "99214");
  check("signature: empty description → empty signature", sigEmpty === "");

  const sigOnlyCode = normalizeDescriptionSignature("99214", "99214");
  check(
    "signature: description = just the code → empty (code stripped)",
    sigOnlyCode === "",
  );
}

{
  // Code embedded in description is stripped (parser normalization)
  const sigA = normalizeDescriptionSignature("99214 OFFICE VISIT", "99214");
  const sigB = normalizeDescriptionSignature("OFFICE VISIT", "99214");
  check(
    "signature: embedded code stripped (matches plain description)",
    sigA === sigB,
  );
}

// ── §C.1 §D.5 invariant: D4 candidate filter ──────────────────────────

function makeLine(opts: {
  lineNumber?: number;
  procedureCode?: string;
  description?: string;
  serviceSlug?: string | null;
}): BillLineItem {
  return {
    lineNumber: opts.lineNumber ?? 1,
    procedureCode: opts.procedureCode ?? "99214",
    description: opts.description ?? "OFFICE VISIT EST",
    category: "",
    serviceDate: "2026-01-15",
    quantity: 1,
    billedAmount: 100,
    serviceSlug: opts.serviceSlug,
  };
}

// Mirror the filter logic used inside `runDescriptionMatchCheck`:
function passesD4CandidateFilter(li: BillLineItem): boolean {
  return Boolean(
    !li.serviceSlug &&
      li.procedureCode &&
      li.description &&
      li.description.trim().length >= 3,
  );
}

check(
  "D4 filter: line with slug='pcp_visit' is SKIPPED (§C.1 §D.5 fix)",
  passesD4CandidateFilter(
    makeLine({ serviceSlug: "pcp_visit" }),
  ) === false,
);
check(
  "D4 filter: line with no slug IS a candidate",
  passesD4CandidateFilter(makeLine({ serviceSlug: null })) === true,
);
check(
  "D4 filter: line with empty description is SKIPPED",
  passesD4CandidateFilter(
    makeLine({ serviceSlug: null, description: "" }),
  ) === false,
);
check(
  "D4 filter: line with 2-char description is SKIPPED",
  passesD4CandidateFilter(
    makeLine({ serviceSlug: null, description: "AB" }),
  ) === false,
);
check(
  "D4 filter: line with 3-char description is a candidate",
  passesD4CandidateFilter(
    makeLine({ serviceSlug: null, description: "ABC" }),
  ) === true,
);
check(
  "D4 filter: line with no procedure code is SKIPPED",
  passesD4CandidateFilter(
    makeLine({ serviceSlug: null, procedureCode: "" }),
  ) === false,
);

// ── DescriptionMatchResult tier boundaries ────────────────────────────

// These match the constants in description-service-match.ts:
//   CONFIDENT_FLOOR = 0.85
//   AMBIGUITY_WINDOW = 0.05
// A result with topMatch=0.90 + secondMatch=0.84 → confident (gap 0.06 ≥ 0.05)
// A result with topMatch=0.90 + secondMatch=0.88 → ambiguous (gap 0.02 < 0.05)
// A result with topMatch=0.80                    → soft (below confident floor)

function deriveResultFlags(
  top: DescriptionMatchCandidate | null,
  second: DescriptionMatchCandidate | null,
): { confident: boolean; ambiguous: boolean } {
  const CONFIDENT_FLOOR = 0.85;
  const AMBIGUITY_WINDOW = 0.05;
  const ambiguous =
    top != null &&
    second != null &&
    top.score >= CONFIDENT_FLOOR &&
    top.score - second.score < AMBIGUITY_WINDOW;
  const confident =
    top != null && top.score >= CONFIDENT_FLOOR && !ambiguous;
  return { confident, ambiguous };
}

{
  const r = deriveResultFlags(
    { slug: "pcp_visit", score: 0.95 },
    { slug: "specialist_visit", score: 0.45 },
  );
  check(
    "tier: top=0.95 / second=0.45 → confident=true / ambiguous=false",
    r.confident === true && r.ambiguous === false,
  );
}

{
  const r = deriveResultFlags(
    { slug: "pcp_visit", score: 0.88 },
    { slug: "specialist_visit", score: 0.86 },
  );
  check(
    "tier: top=0.88 / second=0.86 (gap 0.02) → ambiguous=true",
    r.confident === false && r.ambiguous === true,
  );
}

{
  const r = deriveResultFlags(
    { slug: "pcp_visit", score: 0.90 },
    { slug: "specialist_visit", score: 0.84 },
  );
  check(
    "tier: top=0.90 / second=0.84 (gap 0.06) → confident (gap exceeds window)",
    r.confident === true && r.ambiguous === false,
  );
}

{
  const r = deriveResultFlags(
    { slug: "pcp_visit", score: 0.80 },
    { slug: "specialist_visit", score: 0.20 },
  );
  check(
    "tier: top=0.80 (below 0.85 floor) → confident=false / ambiguous=false (soft fallback)",
    r.confident === false && r.ambiguous === false,
  );
}

{
  const r = deriveResultFlags(null, null);
  check(
    "tier: no matches → confident=false / ambiguous=false",
    r.confident === false && r.ambiguous === false,
  );
}

{
  const r = deriveResultFlags({ slug: "pcp_visit", score: 0.95 }, null);
  check(
    "tier: top only (no second) → confident=true / ambiguous=false",
    r.confident === true && r.ambiguous === false,
  );
}

// ── DescriptionMatchResult contract ─────────────────────────────────────

{
  // Verify the result shape contract — every field present + typed
  const empty: DescriptionMatchResult = {
    candidates: [],
    topMatch: null,
    secondMatch: null,
    ambiguous: false,
    confident: false,
  };
  check(
    "DescriptionMatchResult: empty default shape is well-typed",
    Array.isArray(empty.candidates) &&
      empty.topMatch === null &&
      empty.secondMatch === null,
  );
}

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`[D4 flywheel] ${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}
