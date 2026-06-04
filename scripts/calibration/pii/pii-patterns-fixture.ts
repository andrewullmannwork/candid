/**
 * Ing-E Phase 0 — PII pattern fixture (Ship Gate G4).
 *
 * Validates src/lib/parser/pii-patterns.ts on three corpora:
 *   1. POSITIVE   — each PII type is detected (auto where expected, review where expected).
 *   2. NEGATIVE   — real coverage strings produce ZERO auto-redactable matches.
 *                   This is the Q1 no-corruption guard: the redactor would do NOTHING to coverage text.
 *   3. MIXED/GUARD — only the PII span is auto-redactable; coverage / plan-name / $-amounts are preserved.
 *
 * Run: npx tsx scripts/calibration/pii/pii-patterns-fixture.ts
 * Exits non-zero on any failure (CI-able).
 */
import {
  findPiiMatches,
  autoRedactableMatches,
  isValidNpi,
} from "@/lib/parser/pii-patterns";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
  }
}

const autoNames = (t: string): string[] => autoRedactableMatches(t).map((m) => m.patternName);
const allNames = (t: string): string[] => findPiiMatches(t).map((m) => m.patternName);
const autoCount = (t: string): number => autoRedactableMatches(t).length;

// ─────────────────────────── 1. NPI checksum unit ───────────────────────────
check("isValidNpi accepts canonical valid NPI 1234567893", isValidNpi("1234567893") === true);
check("isValidNpi rejects 1234567890 (bad check digit)", isValidNpi("1234567890") === false);
check("isValidNpi rejects non-10-digit", isValidNpi("12345") === false);

// ─────────────────────────── 2. POSITIVE (auto) ─────────────────────────────
check("ssn", autoNames("Patient SSN 123-45-6789 on file").includes("ssn"));
check("email", autoNames("reach me at john.doe@example.com please").includes("email"));
check("npi_labeled", autoNames("Rendering provider NPI: 1234567893").includes("npi_labeled"));
check("npi_luhn (valid bare)", autoNames("billed under 1234567893 last week").includes("npi_luhn"));
check("npi_luhn rejects invalid bare", !allNames("code 1234567890 here").includes("npi_luhn"));
check("member_id_labeled", autoNames("Member ID: W123456789").includes("member_id_labeled"));
check("group_number_labeled", autoNames("Group #: 0045821").includes("group_number_labeled"));
check("dob_labeled", autoNames("DOB: 01/15/1980").includes("dob_labeled"));
check("account_claim_labeled", autoNames("Claim Number: CLM00123456").includes("account_claim_labeled"));
check("phone_labeled", autoNames("Phone: (555) 123-4567").includes("phone_labeled"));

// ─────────────────────── 3. POSITIVE (insurer-format, auto) ──────────────────
check("insurer_aetna_w_id", autoNames("subscriber W987654321 active").includes("insurer_aetna_w_id"));
check("insurer_bcbs_alpha_prefix", autoNames("XYZ123456789 on card").includes("insurer_bcbs_alpha_prefix"));

// ─────────────────────── 4. REVIEW (surfaced, NEVER auto) ────────────────────
const nameCase = "Patient: John Smith";
check("name_labeled surfaced", allNames(nameCase).includes("name_labeled"));
check("name_labeled NOT auto-redactable (Q4)", !autoNames(nameCase).includes("name_labeled"));
check("standalone 'Plan name:' does NOT match a name", !allNames("Plan name: Gold PPO Plus").includes("name_labeled"));

const bareePhone = "call 555-123-4567 today";
check("phone_bare surfaced", allNames(bareePhone).includes("phone_bare"));
check("phone_bare NOT auto-redactable", !autoNames(bareePhone).includes("phone_bare"));

const longId = "see ABC12345678 for ref";
check("long_alnum_id_run surfaced", allNames(longId).includes("long_alnum_id_run"));
check("long_alnum_id_run NOT auto-redactable", !autoNames(longId).includes("long_alnum_id_run"));

// ───────────── 5. NEGATIVE coverage corpus — ZERO auto-redaction ─────────────
const COVERAGE: string[] = [
  "Primary care visit: $30 copay",
  "10% coinsurance after deductible",
  "$1,500 deductible",
  "$0 after deductible met",
  "Specialist visit $50 copayment",
  "Out-of-pocket maximum: $6,000",
  "Emergency room 20% coinsurance",
  "Generic drugs $10 / Preferred brand $35",
  "Inpatient hospital: 30% coinsurance per admission",
  "Annual deductible $2,000 individual / $4,000 family",
  "You pay 40% of allowed amount",
  "Diagnostic test (x-ray, blood work): $0 copay",
];
for (const s of COVERAGE) {
  check(`coverage preserved (0 auto): "${s}"`, autoCount(s) === 0);
}

// ─────────────── 6. MIXED + COVERAGE_GUARD — only PII redacted ───────────────
const mix1 = "Member ID: W123456789 — Primary care visit $30 copay";
const mix1Auto = autoRedactableMatches(mix1);
check("mix1: ≥1 auto match (the member id)", mix1Auto.length >= 1);
check(
  "mix1: no auto match touches coverage ($/copay)",
  mix1Auto.every((m) => !m.value.includes("$") && !/copay/i.test(m.value) && !m.value.includes("%")),
);
check(
  "mix1: '$30 copay' substring untouched by any auto match",
  (() => {
    const cov = mix1.indexOf("$30 copay");
    return mix1Auto.every((m) => m.end <= cov || m.start >= cov + "$30 copay".length);
  })(),
);

const mix2 = "Patient: Jane Doe, DOB: 02/03/1975, Member ID: 5551234, Plan: Gold PPO $25 copay";
const mix2AutoNames = autoNames(mix2);
check("mix2: DOB auto-redacted", mix2AutoNames.includes("dob_labeled"));
check("mix2: member id auto-redacted", mix2AutoNames.includes("member_id_labeled"));
check("mix2: name is review (NOT auto)", !mix2AutoNames.includes("name_labeled") && allNames(mix2).includes("name_labeled"));
check(
  "mix2: 'Gold PPO' + '$25 copay' untouched by auto",
  autoRedactableMatches(mix2).every((m) => !/Gold|PPO|copay/i.test(m.value) && !m.value.includes("$")),
);

// GUARD: a $-prefixed 10-digit (looks like NPI) is a dollar amount → suppressed
check("guard: $1234567893 (NPI-shaped $ amount) is NOT auto-redacted", autoCount("$1234567893") === 0);
check(
  "guard: same digits bare ARE detected (proves it's the guard, not a miss)",
  autoNames("ref 1234567893 ok").includes("npi_luhn"),
);

// ─────────────────────────────── report ─────────────────────────────────────
const total = pass + fail;
console.log(`\nPII pattern fixture: ${pass}/${total} PASS`);
if (fail > 0) {
  console.log(`\n${fail} FAILURE(S):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all assertions passed (incl. zero coverage-corruption)\n");
