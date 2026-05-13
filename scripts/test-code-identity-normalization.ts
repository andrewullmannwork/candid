// Smoke test for src/lib/parser/code-identity.ts normalizeDescriptionSignature.
// DB + Haiku functions tested separately (require DB connection / API key).
//
// Run: npx tsx scripts/test-code-identity-normalization.ts

import { normalizeDescriptionSignature } from "../src/lib/parser/code-identity";

interface Case {
  desc: string;
  code: string;
  expected: string;
  why: string;
}

const cases: Case[] = [
  // Andrew's bill — same code, different provider wordings should collapse
  {
    desc: "HC PR 99395 PREV VISIT EST AGE 18-39",
    code: "99395",
    expected: "18 39 age est prev visit",
    why: "Andrew's preventive bill — code stripped, prev/est abbrev, sorted",
  },
  {
    desc: "Office Visit, Preventive, Established",
    code: "99395",
    expected: "est office prev visit",
    why: "Different wording same code — overlaps but distinct (different sig)",
  },
  {
    desc: "PREV VISIT EST PT 18-39",
    code: "99395",
    expected: "18 39 est prev visit",
    why: "PT stopword dropped, same as Andrew's bill minus 'age'",
  },

  // COVID vaccine — vacc abbrev collapses variants
  {
    desc: "91320 COVID-19 VACCINE PFIZER",
    code: "91320",
    expected: "19 covid pfizer vacc",
    why: "Vaccine → vacc; code stripped; sorted",
  },
  {
    desc: "Pfizer COVID Vaccine",
    code: "91320",
    expected: "covid pfizer vacc",
    why: "Same vaccine, different wording",
  },

  // Vaccine admin
  {
    desc: "G0008 IMMUNIZATION ADMIN",
    code: "G0008",
    expected: "admin immun",
    why: "Immunization → immun; G-code stripped",
  },

  // Order-invariance: word order shouldn't matter
  {
    desc: "office visit preventive",
    code: "99395",
    expected: "office prev visit",
    why: "Sort makes order irrelevant",
  },
  {
    desc: "preventive visit office",
    code: "99395",
    expected: "office prev visit",
    why: "Same tokens, different order → same signature",
  },

  // Patient-ID-like numbers dropped; MRN literal survives (collapses across
  // providers via signature; Haiku similarity handles edge cases).
  {
    desc: "OFFICE VISIT MRN 1234567",
    code: "99213",
    expected: "mrn office visit",
    why: "7-digit patient ID dropped; 'mrn' literal stays (noise-tolerant)",
  },

  // Punctuation stripped
  {
    desc: "OFFICE/OUTPT VISIT, EST PT",
    code: "99213",
    expected: "est office outpt visit",
    why: "Punctuation gone; outpatient → outpt",
  },

  // Empty / pure-noise
  {
    desc: "",
    code: "99213",
    expected: "",
    why: "Empty description → empty signature",
  },
  {
    desc: "   ",
    code: "99213",
    expected: "",
    why: "Whitespace-only → empty signature",
  },
  {
    desc: "99213",
    code: "99213",
    expected: "",
    why: "Code-only description → empty after strip",
  },

  // Stopwords + abbrev mix — "with" preserved (semantically meaningful for
  // imaging: "with contrast" vs "without contrast" differ in CPT)
  {
    desc: "Established Patient with Preventive Visit",
    code: "99395",
    expected: "est patient prev visit with",
    why: "'and'/'the'/'a' drop; 'with' preserved for imaging semantics",
  },
];

let pass = 0;
const failures: string[] = [];

for (const c of cases) {
  const got = normalizeDescriptionSignature(c.desc, c.code);
  if (got === c.expected) {
    pass++;
  } else {
    failures.push(
      `  FAIL: desc="${c.desc}" code="${c.code}"\n    expected="${c.expected}"\n    got     ="${got}"\n    why: ${c.why}`,
    );
  }
}

console.log(`\n[code-identity normalization] ${pass}/${cases.length} passed`);
if (failures.length) {
  console.log(failures.join("\n"));
  process.exit(1);
}
process.exit(0);
