/**
 * dfy-intake-gates — S330. Locks the intake front door (Gates 0–6 + runway),
 * the engagement state machine, and the business-day arithmetic.
 *
 * The invariant that matters: FAIL-CLOSED. A fully-documented CA member with a
 * composed appeal, a denial on record, an accepted plan class, every exclusion
 * answered "no", runway above threshold and the marketing gate attested is
 * ELIGIBLE — and flipping ANY ONE fact to unknown or excluded declines, naming
 * that gate first.
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/dfy-intake-gates.ts
 */
import { evaluateIntake, type IntakeFacts, MEMBER_DECLINE_COPY, memberDeclineCopy, GATE_LABELS } from "../../../../src/lib/dfy/intake-gates";
import { businessDaysUntil, parseDateOnly } from "../../../../src/lib/dfy/business-days";
import {
  assertTransition,
  canTransition,
  ENGAGEMENT_STATUSES,
  TERMINAL_STATUSES,
  type EngagementStatus,
} from "../../../../src/lib/dfy/engagement-state";
import { parseDfyConfig, DFY_CONFIG_DEFAULTS } from "../../../../src/lib/dfy/config";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } }

const eligible: IntakeFacts = {
  memberState: "CA",
  classification: { coverageType: "commercial_fully_insured", caRegulator: "DMHC", source: "user_screening", answeredAt: "2026-09-01T00:00:00Z" },
  planSponsorType: "single_employer",
  secondaryCoverageCdi: false,
  governmentProgram: false,
  litigationAttested: false,
  inCollections: false,
  memberAskedWhatToArgue: false,
  part2Records: false,
  compositionEvents: { groundSelected: true, letterAdopted: true },
  adverseDeterminationDate: "2026-08-20",
  runwayBusinessDays: 40,
  refusalRunwayBusinessDays: 10,
  marketingGateVerifiedOn: "2026-09-01",
};

// 1 — the baseline is eligible with every gate passing
{
  const d = evaluateIntake(eligible);
  check("baseline eligible", d.eligible);
  check("baseline: no decline reason", d.declineReason === null);
  check("baseline: nine gate rows", d.gates.length === 9);
  check("baseline: every gate passes", d.gates.every((g) => g.pass));
  check("gate 4 (member-files split) always passes", d.gates.find((g) => g.id === "4")?.pass === true);
  check("lane insurer + member files at state level", d.lane === "insurer" && d.memberFilesAtStateLevel === true);
}

function failsAt(facts: IntakeFacts, id: string, name: string) {
  const d = evaluateIntake(facts);
  const g = d.gates.find((x) => x.id === id);
  check(`${name}: declined`, !d.eligible);
  check(`${name}: gate ${id} fails`, g?.pass === false);
  check(`${name}: reason present`, typeof g?.reason === "string" && g!.reason!.length > 0);
}

// 2 — each single-fact mutation trips its gate
failsAt({ ...eligible, memberState: "TX" }, "lane", "TX member");
failsAt({ ...eligible, memberState: null }, "lane", "state missing");
failsAt({ ...eligible, compositionEvents: { groundSelected: true, letterAdopted: false } }, "0", "letter not adopted");
failsAt({ ...eligible, compositionEvents: { groundSelected: false, letterAdopted: true } }, "0", "grounds not selected");
failsAt({ ...eligible, memberAskedWhatToArgue: true }, "0", "member asked what to argue");
failsAt({ ...eligible, memberAskedWhatToArgue: null }, "0", "asked-what-to-argue unanswered (fail closed)");
failsAt({ ...eligible, classification: { ...eligible.classification!, caRegulator: "CDI" } }, "1", "CDI named");
failsAt({ ...eligible, classification: { ...eligible.classification!, caRegulator: "unknown" } }, "1", "no regulator named");
failsAt({ ...eligible, classification: null }, "1", "no classification (undocumented funding)");
failsAt({ ...eligible, classification: { ...eligible.classification!, coverageType: "medicare" } }, "1", "medicare");
failsAt({ ...eligible, classification: { ...eligible.classification!, coverageType: "employer_self_funded" }, planSponsorType: "mewa_association_peo" }, "2", "MEWA self-funded");
failsAt({ ...eligible, classification: { ...eligible.classification!, coverageType: "employer_self_funded" }, planSponsorType: "mewa_association_peo" }, "3", "MEWA is also a hard exclude");
failsAt({ ...eligible, classification: { ...eligible.classification!, coverageType: "employer_self_funded" }, planSponsorType: null }, "2", "self-funded sponsor type unanswered");
failsAt({ ...eligible, secondaryCoverageCdi: true }, "3", "secondary CDI policy");
failsAt({ ...eligible, secondaryCoverageCdi: null }, "3", "secondary coverage unchecked (fail closed)");
failsAt({ ...eligible, governmentProgram: true }, "3", "TRICARE/VA");
failsAt({ ...eligible, governmentProgram: null }, "3", "government program unanswered (fail closed)");
failsAt({ ...eligible, litigationAttested: true }, "3", "lawsuit on record");
failsAt({ ...eligible, litigationAttested: null }, "3", "litigation screening unanswered (fail closed)");
failsAt({ ...eligible, inCollections: true }, "3", "in collections");
failsAt({ ...eligible, part2Records: true }, "3", "Part 2 records present");
failsAt({ ...eligible, part2Records: null }, "3", "Part 2 screen unanswered (fail closed)");
failsAt({ ...eligible, adverseDeterminationDate: null }, "5", "no adverse determination");
failsAt({ ...eligible, marketingGateVerifiedOn: null }, "6", "marketing gate unattested");
failsAt({ ...eligible, runwayBusinessDays: 9 }, "runway", "runway below threshold");
failsAt({ ...eligible, runwayBusinessDays: null }, "runway", "runway unknown (fail closed)");
{
  const d = evaluateIntake({ ...eligible, runwayBusinessDays: 10 });
  check("runway exactly at threshold passes", d.gates.find((g) => g.id === "runway")?.pass === true);
}

// 3 — accepted classes
{
  const sf = evaluateIntake({ ...eligible, classification: { coverageType: "employer_self_funded", source: "user_screening", answeredAt: "x" } });
  check("single-employer self-funded ERISA is accepted", sf.eligible);
  const pub = evaluateIntake({ ...eligible, classification: { coverageType: "employer_self_funded_public", source: "user_screening", answeredAt: "x" } });
  check("self-funded governmental/church is accepted", pub.eligible);
}

// 4 — the decline names the FIRST failing gate
{
  const d = evaluateIntake({ ...eligible, memberState: "TX", marketingGateVerifiedOn: null });
  check("first failing gate names the decline (lane before 6)", d.declineReason === d.gates.find((g) => g.id === "lane")?.reason);
}

// 5 — business days (Mon–Fri; date-only, UTC calendar)
{
  const fri = new Date(Date.UTC(2026, 8, 4)); // Fri Sep 4 2026
  check("Fri → next Mon = 1 business day", businessDaysUntil(fri, "2026-09-07") === 1);
  check("Fri → next Fri = 5 business days", businessDaysUntil(fri, "2026-09-11") === 5);
  check("same day = 0", businessDaysUntil(fri, "2026-09-04") === 0);
  check("past deadline is negative", businessDaysUntil(fri, "2026-09-01") === -3);
  check("non-date → null", businessDaysUntil(fri, "soon") === null);
  check("null → null", businessDaysUntil(fri, null) === null);
  check("parseDateOnly rejects ISO timestamps", parseDateOnly("2026-09-04T00:00:00Z") === null);
}

// 6 — the state machine
{
  check("6 statuses", ENGAGEMENT_STATUSES.length === 6);
  check("eligibility_pending → signed", canTransition("eligibility_pending", "signed"));
  check("eligibility_pending → terminated", canTransition("eligibility_pending", "terminated"));
  check("eligibility_pending ↛ active", !canTransition("eligibility_pending", "active"));
  check("signed → active", canTransition("signed", "active"));
  check("active → completed", canTransition("active", "completed"));
  check("active → converted", canTransition("active", "converted"));
  check("active ↛ signed", !canTransition("active", "signed"));
  for (const t of TERMINAL_STATUSES) {
    check(`${t} is terminal`, ENGAGEMENT_STATUSES.every((s: EngagementStatus) => !canTransition(t, s)));
  }
  let threw = false;
  try { assertTransition("completed", "active"); } catch { threw = true; }
  check("assertTransition throws on a bad edge", threw);
}

// 7 — config parsing (bad values → defaults; allowlist filtered; date regex)
{
  const c = parseDfyConfig({ concurrent_cap: 8, refusal_runway_business_days: "ten", ip_allowlist: ["1.2.3.4", 5, " "], ip_allowlist_enforced: "yes", marketing_gate_verified_on: "2026/09/01" });
  check("cap parsed", c.concurrentCap === 8);
  check("bad runway → default", c.refusalRunwayBusinessDays === DFY_CONFIG_DEFAULTS.refusalRunwayBusinessDays);
  check("allowlist keeps only non-empty strings", JSON.stringify(c.ipAllowlist) === JSON.stringify(["1.2.3.4"]));
  check("enforced only on boolean true", c.ipAllowlistEnforced === false);
  check("verified-on requires YYYY-MM-DD", c.marketingGateVerifiedOn === null);
  check("null config → defaults", JSON.stringify(parseDfyConfig(null)) === JSON.stringify(DFY_CONFIG_DEFAULTS));
}

// ── member-facing decline copy (S330 copy round): every gate has a plain sentence; the audit reason never reaches the member ──
{
  const ids = Object.keys(GATE_LABELS) as Array<keyof typeof GATE_LABELS>;
  check("every gate has member decline copy", ids.every((id) => typeof MEMBER_DECLINE_COPY[id] === "string" && MEMBER_DECLINE_COPY[id].length > 0));
  check("member copy never leaks operator vocabulary", ids.every((id) => !/marketing|sweep|regulator lane|config|gate/i.test(MEMBER_DECLINE_COPY[id])));
  check("eligible decision → no member copy", memberDeclineCopy({ eligible: true, gates: [] }) === null);
  check("first failing gate names the member copy", memberDeclineCopy({ eligible: false, gates: [{ id: "lane", pass: true }, { id: "6", pass: false }, { id: "runway", pass: false }] }) === MEMBER_DECLINE_COPY["6"]);
}

console.log(`dfy-intake-gates: ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
