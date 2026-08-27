/**
 * forum-router — S325 (PR-B, D4). The four router invariants (counsel memo 05
 * §F) + the caught-and-fixed regression locks from memo 04, over the merged
 * forums.ts.
 *
 *  1. No clinical-conduct forum is composable into a letter carrying a
 *     disputed dollar amount — structurally: every licensing_discipline forum
 *     is actionOnly, and the composer accessor throws on actionOnly.
 *  2. actionOnly ⟹ letterString === null, and forumLetterString() throws.
 *  3. `cannot` is verbatim agency language; the four boards that publish no
 *     billing limitation carry [] (the UI renders the honest sentence).
 *  4. A zero-forum result exists and carries a notice; the price-level empty
 *     state (NO_FORUM_NOTICE) names the honest routes.
 *
 * Regression locks (memo 04 flags 12/16, §0.4/§0.5 — DO NOT REGRESS):
 *  - The general BBPA letterString cites RCW 48.49.020(1)/(2)(c), never .030;
 *    the .030 citation exists ONLY in the behavioral-health variant.
 *  - Ground ambulance is RCW 48.49.200 (its own section), never .020.
 *  - unknown CA regulator → DMHC (it forwards; the reverse is undocumented).
 *  - Self-funded ERISA never receives state-insurance forums; WA opted-in
 *    self-funded gets wa_bbpa ONLY (never the OIC complaint/IRO machinery —
 *    RCW 48.49.130 binds electing plans to five sections, not the chapter).
 *  - The generic fallback doors reproduce the retired COMPLAINT_DOORS
 *    literals byte-exact (flag-OFF renders must not move).
 *  - ENROLLMENT_SPLIT is internal-only (never letter copy) and templates.ts
 *    never imports it.
 *  - Every forum's citationIds resolve to CITATION_REGISTRY entries.
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/forum-router.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ALL_FORUMS,
  CA_FORUMS,
  CA_PROVIDER_CONDUCT_FORUMS,
  CA_BILLING_CONDUCT_FORUMS,
  WA_FORUMS,
  CA_CLINICAL_BY_LICENSE,
  NO_FORUM_NOTICE,
  DEAD_END_REFERRALS,
  ENROLLMENT_SPLIT,
  FORUM_ROLE_ORDER,
  VERIFIED_ON,
  forumLetterString,
  fallbackForums,
  orderForums,
  route,
} from "../../../../src/lib/disputes/forums";
import { CITATION_REGISTRY } from "../../../../src/lib/disputes/citation-registry";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

const forums = Object.values(ALL_FORUMS);

// --- Invariants 1 + 2 -------------------------------------------------------
for (const f of forums) {
  if (f.actionOnly) {
    check(`invariant 2: actionOnly ⟹ letterString null (${f.id})`, f.letterString === null);
    let threw = false;
    try {
      forumLetterString(f);
    } catch {
      threw = true;
    }
    check(`invariant 2: composer throws on actionOnly (${f.id})`, threw);
  }
  if (f.role === "licensing_discipline") {
    check(`invariant 1: licensing forum is actionOnly (${f.id})`, f.actionOnly);
  }
}
check(
  "invariant 1: every CA provider-conduct entry is actionOnly",
  Object.values(CA_PROVIDER_CONDUCT_FORUMS).every((f) => f.actionOnly && f.letterString === null),
);
check("wa_doh is actionOnly (S325 ruling — memo 05 §0 postdates canonical)", WA_FORUMS.wa_doh.actionOnly);

// Criminal-referral forums: action-only, forever.
for (const id of ["ca_da_consumer", "ca_cdi_fraud", "ca_dhcs_fraud", "ca_dmfea"]) {
  check(`criminal-referral forum actionOnly (${id})`, ALL_FORUMS[id]?.actionOnly === true);
}
check(
  "DMFEA hint carries the user-authored-narrative rule",
  CA_BILLING_CONDUCT_FORUMS.ca_dmfea.menuHint.includes("your own words"),
);

// --- Invariant 3: verbatim cannot -------------------------------------------
check(
  "MBC cannot keeps the narrow double-payment carve-out verbatim",
  CA_PROVIDER_CONDUCT_FORUMS.ca_mbc.cannot.some((c) =>
    c.includes("unless there is a double payment by the insurance company"),
  ),
);
check(
  "DOH cannot keeps 'Cannot get money back' scope verbatim",
  WA_FORUMS.wa_doh.cannot.some((c) => c.includes("Cannot get money back you feel is owed to you")),
);
check(
  "HCAI cannot keeps the no-general-billing-jurisdiction sentence verbatim",
  CA_FORUMS.ca_hcai_charity_care.cannot.some((c) =>
    c.includes("does not have jurisdiction (authority) over general billing and fee disputes"),
  ),
);
const NO_LIMITATION_BOARDS = ["ca_bvnpt", "ca_bbs", "ca_pmbc", "ca_rcb"];
for (const id of NO_LIMITATION_BOARDS) {
  check(
    `no-limitation board carries [] not synthesized text (${id})`,
    ALL_FORUMS[id]?.cannot.length === 0,
  );
}

// --- Invariant 4: honest empty states ---------------------------------------
check("NO_FORUM_NOTICE names the honest routes", /small claims/i.test(NO_FORUM_NOTICE) && /negotiat/i.test(NO_FORUM_NOTICE));
const medicare = route({ state: "CA", coverage: "medicare", dispute: "claim_billing_dispute" });
check("medicare → zero forums + notice", medicare.forums.length === 0 && !!medicare.notice);
check("dead-end referral copy exists for medicare", !!DEAD_END_REFERRALS.medicare);

// --- Regression locks (memo 04) ---------------------------------------------
const bbpa = WA_FORUMS.wa_bbpa;
check(
  "BBPA general string cites .020(1) + .020(2)(c), never .030",
  !!bbpa.letterString &&
    bbpa.letterString.includes("RCW 48.49.020(1)") &&
    bbpa.letterString.includes("RCW 48.49.020(2)(c)") &&
    !bbpa.letterString.includes("48.49.030"),
);
check(
  "BBPA behavioral-health variant exists and owns the only .030 citations",
  !!bbpa.letterStringBehavioralHealthEmergency &&
    bbpa.letterStringBehavioralHealthEmergency.includes("RCW 48.49.030(1)(a)") &&
    bbpa.letterStringBehavioralHealthEmergency.includes("RCW 48.49.030(1)(e)"),
);
check(
  "ground ambulance is .200, its own section, in the authority text",
  (bbpa.authority ?? "").includes("RCW 48.49.200"),
);

const unknownCa = route({
  state: "CA",
  coverage: "commercial_fully_insured",
  dispute: "claim_billing_dispute",
  caRegulator: "unknown",
});
check(
  "unknown CA regulator → DMHC (it forwards misroutes)",
  unknownCa.forums.length === 1 && unknownCa.forums[0].id === "ca_dmhc_complaint",
);

const selfFundedCa = route({ state: "CA", coverage: "employer_self_funded", dispute: "claim_billing_dispute" });
check(
  "self-funded CA → EBSA only, no state forum",
  selfFundedCa.forums.length === 1 && selfFundedCa.forums[0].id === "dol_ebsa" && !!selfFundedCa.notice,
);
const optedIn = route({
  state: "WA",
  coverage: "employer_self_funded",
  dispute: "balance_bill",
  waSelfFundedOptedIn: true,
});
check(
  "WA opted-in self-funded balance bill → wa_bbpa first, EBSA behind, NEVER the OIC complaint/IRO",
  optedIn.forums[0]?.id === "wa_bbpa" &&
    optedIn.forums.some((f) => f.id === "dol_ebsa") &&
    !optedIn.forums.some((f) => f.id === "wa_oic_complaint" || f.id === "wa_oic_external_review"),
);
const notOpted = route({ state: "WA", coverage: "employer_self_funded", dispute: "balance_bill" });
check(
  "WA non-electing self-funded balance bill → federal NSA desk, never wa_bbpa",
  notOpted.forums.some((f) => f.id === "cms_no_surprises") && !notOpted.forums.some((f) => f.id === "wa_bbpa"),
);

// CA billing-conduct branch: conduct forums only; DFPI is the only composable
// collector string; DA/fraud units stay action-only.
const caBilling = route({ state: "CA", coverage: "commercial_fully_insured", dispute: "provider_billing_conduct" });
check(
  "CA billing-conduct pool = AG + DFPI + DA + CDI-Fraud",
  caBilling.forums.map((f) => f.id).sort().join(",") === "ca_ag_piu,ca_cdi_fraud,ca_da_consumer,ca_dfpi",
);
check(
  "CA clinical-conduct pool is the license-routed board set, all actionOnly",
  route({ state: "CA", coverage: "commercial_fully_insured", dispute: "provider_clinical_conduct" }).forums.every(
    (f) => f.actionOnly,
  ),
);
check(
  "every CA_CLINICAL_BY_LICENSE target exists",
  Object.values(CA_CLINICAL_BY_LICENSE).every((id) => !!ALL_FORUMS[id]),
);

// --- The generic fallback: byte-exact door literals (flag-OFF must not move) -
const fb = fallbackForums();
const EXPECTED_DOORS = [
  ["ag", "State attorney general", "Hospital billing practices, collection abuse, charity care", "https://www.naag.org/find-my-ag/"],
  ["cfpb", "CFPB", "Debt collectors, credit-report errors", "https://www.consumerfinance.gov/complaint/"],
  ["cms", "CMS No Surprises Help Desk", "Surprise billing, good-faith-estimate violations", "https://www.cms.gov/medical-bill-rights/help/submit-a-complaint"],
  ["doi", "State insurance department", "Insurer conduct, failed appeals", "https://content.naic.org/consumer/how-to-file-complaint"],
] as const;
check("fallback pool has the four generic doors in fixed order", fb.length === 4);
EXPECTED_DOORS.forEach(([id, label, hint, url], i) => {
  check(
    `generic door ${id}: byte-exact label/hint/url`,
    fb[i]?.id === id && fb[i]?.menuLabel === label && fb[i]?.menuHint === hint && fb[i]?.url === url,
  );
});
check(
  "non-CA/WA state routes to the generic fallback",
  route({ state: "TX", coverage: "commercial_fully_insured", dispute: "claim_billing_dispute" })
    .forums.map((f) => f.id)
    .join(",") === "ag,cfpb,cms,doi",
);

// --- Fixed ordering, no featuring (R14) --------------------------------------
const ordered = orderForums([WA_FORUMS.wa_ag, WA_FORUMS.wa_oic_external_review, WA_FORUMS.wa_oic_complaint]);
check(
  "orderForums = role order then id, identical for everyone",
  ordered.map((f) => f.id).join(",") === "wa_oic_external_review,wa_oic_complaint,wa_ag",
);
check("no 'suggested'/'recommended' field exists on Forum", !("suggested" in bbpa) && !("recommended" in bbpa));
check("FORUM_ROLE_ORDER covers every role in use", forums.every((f) => FORUM_ROLE_ORDER.includes(f.role)));

// --- Hygiene ------------------------------------------------------------------
const ids = forums.map((f) => f.id);
check("forum ids unique", new Set(ids).size === ids.length);
check(
  "every citationId resolves to a registry entry",
  forums.every((f) => f.citationIds.every((c) => c in CITATION_REGISTRY)),
);
check("VERIFIED_ON stamped", /^\d{4}-\d{2}-\d{2}$/.test(VERIFIED_ON));
check("ENROLLMENT_SPLIT is internal-only", ENROLLMENT_SPLIT.useAsLetterCopy === false);
const templatesSrc = readFileSync(resolve(__dirname, "../../../../src/lib/disputes/templates.ts"), "utf8");
check("templates.ts never imports ENROLLMENT_SPLIT", !templatesSrc.includes("ENROLLMENT_SPLIT"));

// -----------------------------------------------------------------------------
console.log(`\nforum-router fixture: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
