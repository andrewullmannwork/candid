/**
 * dfy-member-status — S331. Locks the ONE member-facing vocabulary for a DFY
 * engagement, and the boundary between it and the operator's.
 *
 * The defect this guards against: four surfaces independently turned the same
 * engagement facts into member text (the signing page's chip, its status
 * paragraph, its five-step strip, and the claim page's card), and they had
 * already drifted into three different sentences for the ONE step the member
 * still owes. Worse, the OPERATOR's `derivePhase` string was printed to the
 * member as "Current phase: Waiting on activation".
 *
 *   1. every reachable state produces a headline, a detail and a step index —
 *      no state falls through to an empty card
 *   2. the step index always points inside the strip, and only the step the
 *      member owes is ever named as theirs
 *   3. "choose your dispute path" is the ONE phrasing for the composition step
 *      (the three old dialects are gone)
 *   4. the load-bearing "All five documents" copy matches the real stack size
 *      for BOTH payers — sponsor swaps an instrument, never adds one
 *   5. the module never claims "nothing else is needed from you" unless the
 *      caller actually vouched for the fee state
 *   6. a decline outranks the status, and never leaks the operator's audit
 *      wording
 *   7. the revisit notice names the day it was asked, and omits the clause
 *      rather than guessing when the date is unknown
 *   8. NO member string contains operator vocabulary
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/dfy-member-status.ts
 */
import {
  memberStatus,
  memberRevisitNotice,
  dfyFeeOutstanding,
  MEMBER_STEPS,
  MEMBER_INSTRUMENT_COUNT,
  type MemberStatusFacts,
} from "../../../../src/lib/dfy/member-status";
import { requiredDfyConsents } from "../../../../src/lib/dfy/paper";
import {
  ENGAGEMENT_STATUSES,
  LIVE_ENGAGEMENT_STATUSES,
  TERMINAL_STATUSES,
} from "../../../../src/lib/dfy/engagement-state";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } }

const base: MemberStatusFacts = {
  status: "eligibility_pending",
  allSigned: false,
  composed: false,
  screened: null,
  paymentRequired: false,
};

// 1 — every reachable state says something
const matrix: MemberStatusFacts[] = [];
for (const status of ENGAGEMENT_STATUSES) {
  for (const allSigned of [false, true]) {
    for (const composed of [false, true]) {
      for (const screened of [null, { eligible: true }, { eligible: false, declineReason: "Right now this service is open in California only." }]) {
        for (const paymentRequired of [undefined, false, true]) {
          matrix.push({ ...base, status, allSigned, composed, screened, paymentRequired });
        }
      }
    }
  }
}
const all = matrix.map((f) => ({ f, s: memberStatus(f) }));
check(`every state produces a headline (${matrix.length} combinations)`,
  all.every(({ s }) => typeof s.headline === "string" && s.headline.trim().length > 0));
check("every state produces a detail", all.every(({ s }) => s.detail.trim().length > 0));
check("every state produces a chip", all.every(({ s }) => s.chip.trim().length > 0));
check("every state produces a CTA label", all.every(({ s }) => s.ctaLabel.trim().length > 0));

// 2 — the step index is always inside the strip
check("step index is always within the strip",
  all.every(({ s }) => Number.isInteger(s.stepIndex) && s.stepIndex >= 0 && s.stepIndex < MEMBER_STEPS.length));
check("a terminal status always reads closed",
  all.filter(({ f }) => TERMINAL_STATUSES.has(f.status)).every(({ s }) => s.closed));
check("a live status never reads closed",
  all.filter(({ f }) => LIVE_ENGAGEMENT_STATUSES.includes(f.status)).every(({ s }) => !s.closed));
check("closed and active states never name a next step for the member",
  all.filter(({ s }) => s.closed).every(({ s }) => s.nextStep === null));

// 3 — ONE phrasing for the composition step
const needsCompose = memberStatus({ ...base, status: "signed", allSigned: true, composed: false });
check("the composition step is 'choose your dispute path'",
  needsCompose.detail.includes("choose your dispute path"));
check("the strip names the same step", MEMBER_STEPS[2] === "Choose your dispute path");
check("the composition step points at the strip's step 2", needsCompose.stepIndex === 2);
check("the retired dialects are gone",
  all.every(({ s }) => !/press .?Dispute this charge/i.test(s.detail) && !/in the free tool/i.test(s.detail) && !/what to argue/i.test(s.detail)));

// 4 — the load-bearing count matches the real stack, for BOTH payers
check("member_paid stack is the count the copy claims",
  requiredDfyConsents("member_paid").length === MEMBER_INSTRUMENT_COUNT);
check("sponsor_paid stack is the SAME size (swap, never add)",
  requiredDfyConsents("sponsor_paid").length === MEMBER_INSTRUMENT_COUNT);
check("the signed copy says 'All five documents'",
  memberStatus({ ...base, status: "signed", allSigned: true, composed: true, paymentRequired: false })
    .headline === "All five documents are signed.");

// 5 — never over-claim when the fee state is unknown
const vouched = memberStatus({ ...base, status: "signed", allSigned: true, composed: true, paymentRequired: false });
const unknown = memberStatus({ ...base, status: "signed", allSigned: true, composed: true, paymentRequired: undefined });
check("with the fee vouched for, we say nothing else is needed",
  vouched.detail.includes("Nothing else is needed from you"));
check("with the fee UNKNOWN, we do NOT say nothing else is needed",
  !unknown.detail.includes("Nothing else is needed"));
check("both still promise the email either way",
  vouched.detail.includes("will email you") && unknown.detail.includes("will email you"));
const owed = memberStatus({ ...base, status: "signed", allSigned: true, composed: true, paymentRequired: true, feeCents: 500 });
check("an outstanding fee is named with its amount", owed.detail.includes("$5.00"));
check("an outstanding fee is the member's next step", owed.nextStep === "Pay the fee");

// the fee predicate itself
check("fee outstanding only when signed + member_paid + a real fee",
  dfyFeeOutstanding({ status: "signed", payer: "member_paid", metadata: {} }, 500) === true);
check("no fee in the free pilot",
  dfyFeeOutstanding({ status: "signed", payer: "member_paid", metadata: {} }, 0) === false);
check("sponsor-paid never owes a member fee",
  dfyFeeOutstanding({ status: "signed", payer: "sponsor_paid", metadata: {} }, 500) === false);
check("a succeeded payment clears it",
  dfyFeeOutstanding({ status: "signed", payer: "member_paid", metadata: { payment: { status: "succeeded" } } }, 500) === false);
check("an active matter is past the fee gate",
  dfyFeeOutstanding({ status: "active", payer: "member_paid", metadata: {} }, 500) === false);

// 6 — a decline outranks the status and speaks the member's sentence
const declined = memberStatus({
  ...base, status: "signed", allSigned: true, composed: true,
  screened: { eligible: false, declineReason: "We're not taking new matters right now." },
});
check("a decline outranks the signed state", declined.headline === "We can't take this one on.");
check("the decline carries the member's own sentence",
  declined.detail === "We're not taking new matters right now.");
check("a decline offers the member no next step", declined.nextStep === null);
check("a decline with no sentence still says something",
  memberStatus({ ...base, screened: { eligible: false, declineReason: null } }).detail.trim().length > 0);

// 7 — the revisit notice
const r1 = memberRevisitNotice({ status: "signed", allSigned: true, composed: true, screened: null }, "2026-09-02T10:00:00.000Z");
check("revisit names the day it was requested", r1.detail.includes("Requested Sep 2"));
check("revisit reports it is signed", r1.detail.includes("everything signed"));
check("revisit promises the email", r1.detail.includes("will email you"));
const r2 = memberRevisitNotice({ status: "eligibility_pending", allSigned: false, composed: true, screened: null }, "2026-09-02T10:00:00.000Z");
check("unsigned revisit sends them back to signing", r2.ctaLabel === "Finish signing");
check("unsigned revisit says the documents still need signing", r2.detail.includes("still need signing"));
const r3 = memberRevisitNotice({ status: "active", allSigned: true, composed: true, screened: null }, "2026-09-02T10:00:00.000Z");
check("an active matter reads as started", r3.detail.includes("Started Sep 2"));
const r4 = memberRevisitNotice({ status: "signed", allSigned: true, composed: true, screened: null }, null);
check("an unknown date OMITS the clause rather than guessing",
  !r4.detail.includes("Requested") && !r4.detail.includes("undefined") && !r4.detail.includes("Invalid"));
check("every revisit face has a headline and a CTA",
  [r1, r2, r3, r4].every((r) => r.headline.trim().length > 0 && r.ctaLabel.trim().length > 0));

// 8 — no operator vocabulary reaches the member
const OPERATOR_WORDS = [
  "Waiting on activation", "Declined at intake", "Screening",
  "awaiting the member's paper", "designation not yet submitted",
  "Converted — back to the member", "Terminated", "eligibility_pending",
];
const memberText = [
  ...all.flatMap(({ s }) => [s.headline, s.detail, s.chip, s.nextStep ?? "", s.ctaLabel]),
  ...[r1, r2, r3, r4].flatMap((r) => [r.headline, r.detail, r.ctaLabel]),
];
for (const w of OPERATOR_WORDS) {
  check(`no member string says "${w}"`, !memberText.some((t) => t.includes(w)));
}
// "signed", "active" and "completed" are ordinary English as well as status
// slugs ("All five documents are signed") — only the JARGON slugs are a leak.
const JARGON_SLUGS = ENGAGEMENT_STATUSES.filter((st) => !["signed", "active", "completed"].includes(st));
check("no member string leaks a jargon status slug (eligibility_pending / converted / terminated)",
  !memberText.some((t) => JARGON_SLUGS.some((st) => t.includes(st))));
check("no member string contains an underscored identifier",
  !memberText.some((t) => /[a-z]+_[a-z]+/.test(t)));

console.log(`dfy-member-status: ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
