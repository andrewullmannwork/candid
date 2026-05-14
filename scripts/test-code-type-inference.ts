// Smoke test for src/lib/billing/code-type-inference.ts
//
// Run: npx tsx scripts/test-code-type-inference.ts

import { inferProcedureCodeType } from "../src/lib/billing/code-type-inference";

interface Case {
  code: string;
  expected: string | undefined;
  why: string;
}

const cases: Case[] = [
  // CPT (5-digit) — most common path
  { code: "99213", expected: "CPT", why: "Office/outpatient E&M" },
  { code: "99395", expected: "CPT", why: "Preventive visit (Andrew's bill)" },
  { code: "91320", expected: "CPT", why: "COVID-19 vaccine (Andrew's bill)" },
  { code: "73221", expected: "CPT", why: "MRI" },

  // CPT Category II — 4-digit + F (quality reporting; must precede CPT check)
  { code: "3074F", expected: "CAT_II", why: "BP measurement reporting" },
  { code: "0521F", expected: "CAT_II", why: "Plan of care for pain" },

  // HCPCS Level II G-codes — G + 4 digits (Medicare admin)
  { code: "G0008", expected: "G_CODE", why: "Flu vaccine admin" },
  { code: "G8510", expected: "G_CODE", why: "Quality reporting" },

  // HCPCS Level II generic — single letter (not G) + 4 digits
  { code: "J7298", expected: "HCPCS_L2", why: "Drug-administered code from spec example" },
  { code: "A0428", expected: "HCPCS_L2", why: "Ambulance transport" },
  { code: "V2785", expected: "HCPCS_L2", why: "Vision item" },

  // Revenue codes — 4-digit starting with 0
  { code: "0301", expected: "REV", why: "Lab revenue" },
  { code: "0450", expected: "REV", why: "Emergency room revenue" },

  // NDC — 11-digit numeric
  { code: "00074336290", expected: "NDC", why: "Drug NDC 11-digit" },

  // DRG — 3-digit numeric
  { code: "470", expected: "DRG", why: "Major joint replacement" },

  // Lowercase handling
  { code: "g0008", expected: "G_CODE", why: "Lowercase normalizes to G_CODE" },
  { code: "  99213  ", expected: "CPT", why: "Whitespace trimmed" },

  // Empty / undefined
  { code: "", expected: undefined, why: "Empty string returns undefined" },
  { code: "  ", expected: undefined, why: "Whitespace-only returns undefined" },

  // Unknown formats — must return undefined (not collapse to CPT)
  { code: "ABCDE", expected: undefined, why: "Alpha-only no match" },
  { code: "12", expected: undefined, why: "Too short for any code system" },
  { code: "12345678", expected: undefined, why: "8-digit no match" },
];

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const c of cases) {
  const got = inferProcedureCodeType(c.code);
  if (got === c.expected) {
    pass++;
  } else {
    fail++;
    failures.push(`  FAIL: code="${c.code}" expected=${c.expected} got=${got} (${c.why})`);
  }
}

console.log(`\n[code-type-inference] ${pass}/${cases.length} passed`);
if (fail) {
  console.log(failures.join("\n"));
  process.exit(1);
}
process.exit(0);
