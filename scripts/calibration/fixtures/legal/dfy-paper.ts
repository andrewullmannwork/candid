/**
 * dfy-paper — S330. Locks the DFY paper stack (handoff §3):
 *   - five SEPARATE instruments per payer lane; the sponsor code swaps the fee
 *     agreement for the sponsor-paid disclosure; the platform's health-data
 *     consent is re-affirmed last
 *   - every template slot is filled (no {{SLOT}} survives) and an unknown slot
 *     is a build error, never a blank
 *   - the instance hash is deterministic and differs between two members
 *   - the required statements are present byte-exact where the law or the
 *     rulings demand them: the free-process disclosure ALWAYS (any price), no
 *     auto-charge, the §56.11 elements on the authorization, the execution-only
 *     limits + the member-files-at-state-level clause on the designation, the
 *     who-is-named variant, the sponsor data wall (aggregate-only, no control)
 *   - the paper-completeness read
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/dfy-paper.ts
 */
import {
  requiredDfyConsents,
  renderInstrument,
  fillInstrument,
  paperComplete,
  signedInstruments,
  designationChannelFor,
  defaultExpiryDate,
  PDF_INSTRUMENTS,
  ENTITY_NAME,
  type InstrumentContext,
} from "../../../../src/lib/dfy/paper";
import { CONSENT_DOCUMENTS } from "../../../../src/lib/consent/consent-documents";
import { CITATION_REGISTRY } from "../../../../src/lib/disputes/citation-registry";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } }

const ctx: InstrumentContext = {
  memberName: "Maria Alvarez", memberEmail: "maria@example.com", planName: "Blue Shield Bronze 60 PPO", insurerName: "Blue Shield of California",
  claimRef: "CLM-1234", dateOfService: "2025-09-12", channel: "plan_internal_grievance", namedParty: "individual", operatorName: "Andrew Ullmann",
  feeCents: 0, sponsorRef: null, effectiveDate: "2026-09-01", expiryDate: "2027-09-01",
};

// 1 — the stack by payer
{
  const m = requiredDfyConsents("member_paid");
  const s = requiredDfyConsents("sponsor_paid");
  check("member-paid stack is five instruments", m.length === 5);
  check("sponsor-paid stack is five instruments", s.length === 5);
  check("member-paid includes the fee agreement, not the sponsor disclosure", m.includes("dfy_fee_agreement") && !m.includes("dfy_sponsor_paid_disclosure"));
  check("sponsor-paid swaps in the sponsor disclosure", s.includes("dfy_sponsor_paid_disclosure") && !s.includes("dfy_fee_agreement"));
  check("both end with the platform's health-data consent", m[4] === "health_data_upload" && s[4] === "health_data_upload");
  check("the authorization comes first", m[0] === "dfy_authorization_hipaa_cmia");
  check("every DFY instrument is registered in CONSENT_DOCUMENTS", ["dfy_authorization_hipaa_cmia", "dfy_authorized_representative_designation", "dfy_scope_of_engagement", "dfy_fee_agreement", "dfy_sponsor_paid_disclosure"].every((t) => t in CONSENT_DOCUMENTS));
  check("the five DFY instruments render to PDF; health-data consent does not", PDF_INSTRUMENTS.size === 5 && !PDF_INSTRUMENTS.has("health_data_upload"));
}

// 2 — slots
{
  for (const t of ["dfy_authorization_hipaa_cmia", "dfy_authorized_representative_designation", "dfy_scope_of_engagement", "dfy_fee_agreement", "dfy_sponsor_paid_disclosure"] as const) {
    const r = renderInstrument(t, { ...ctx, sponsorRef: "ACME-2026" });
    check(`${t}: no slot survives`, !/\{\{[A-Z_]+\}\}/.test(r.text));
    check(`${t}: names the member`, r.text.includes("Maria Alvarez"));
    check(`${t}: hash is sha256 hex`, /^[0-9a-f]{64}$/.test(r.hash));
  }
  let threw = false;
  try { fillInstrument("hello {{NOPE}}", ctx); } catch { threw = true; }
  check("an unknown slot throws", threw);
  const a = renderInstrument("dfy_scope_of_engagement", ctx);
  const b = renderInstrument("dfy_scope_of_engagement", { ...ctx, memberName: "Jin Chen" });
  check("instance hash is deterministic", a.hash === renderInstrument("dfy_scope_of_engagement", ctx).hash);
  check("instance hash differs per member", a.hash !== b.hash);
  check("the registry hash is the TEMPLATE's, not the instance's", CONSENT_DOCUMENTS.dfy_scope_of_engagement.hash !== a.hash);
}

// 3 — the required statements
{
  const fee0 = renderInstrument("dfy_fee_agreement", ctx).text;
  const fee5 = renderInstrument("dfy_fee_agreement", { ...ctx, feeCents: 500 }).text;
  check("fee agreement states the free-process disclosure at $0", /are FREE processes/.test(fee0));
  check("fee agreement states the free-process disclosure at $5", /are FREE processes/.test(fee5));
  check("fee agreement: $0 during the pilot", fee0.includes("$0.00"));
  check("fee agreement: $5.00, once", fee5.includes("$5.00") && /charged once/.test(fee5));
  check("fee agreement: card on file never auto-charged", /never charged automatically/.test(fee0));
  check("fee agreement: charged only after an adverse determination", /Only after an adverse determination/.test(fee0));
  check("fee agreement: never a subscription", /never sells a subscription/.test(fee0));

  const auth = renderInstrument("dfy_authorization_hipaa_cmia", ctx);
  check("authorization renders in the §56.11 form", auth.authorizationForm === true);
  for (const el of ["WHO IS AUTHORIZED TO DISCLOSE", "WHO IS AUTHORIZED TO RECEIVE", "WHAT INFORMATION", "PURPOSE", "LIMITS ON USE", "EXPIRATION", "RIGHT TO REVOKE", "NO CONDITIONING", "RE-DISCLOSURE", "COPY"]) {
    check(`authorization carries: ${el}`, auth.text.includes(el));
  }
  check("authorization names the expiry date", auth.text.includes("2027-09-01"));
  check("authorization excludes Part 2 records", /42 CFR Part 2/.test(auth.text));

  const des = renderInstrument("dfy_authorized_representative_designation", ctx).text;
  check("designation names the individual operator", des.includes("Andrew Ullmann"));
  check("designation discloses Candid as employer (individual variant)", des.includes(`an employee of ${ENTITY_NAME}`));
  check("designation: execution-only limits", /will not select or change the grounds/.test(des) && /will not advise me whether to accept any offer/.test(des));
  check("designation: the member files at the state level", /I will sign and file those myself/.test(des));
  check("designation (plan channel): no agency filing authority", /does not authorize my representative to file with the California Department of Managed Health Care/.test(des));
  const desErisa = renderInstrument("dfy_authorized_representative_designation", { ...ctx, channel: "erisa_plan", namedParty: "entity" }).text;
  check("designation (ERISA channel) cites the claims-procedure rule", desErisa.includes("29 CFR §2560.503-1(b)(4)"));
  check("designation (entity variant) names the LLC acting through the operator", desErisa.includes(`designate ${ENTITY_NAME}, a California limited liability company`) && desErisa.includes("acting through its employee Andrew Ullmann"));
  check("the ERISA cite is in the citation registry", Object.values(CITATION_REGISTRY).some((c) => c.cite === "29 CFR §2560.503-1(b)(4)"));
  check("the §56.11 cite is in the citation registry", Object.values(CITATION_REGISTRY).some((c) => c.cite === "Cal. Civ. Code §56.11"));

  const scope = renderInstrument("dfy_scope_of_engagement", ctx).text;
  check("scope: conversion triggers named", /CONVERSION BACK TO THE MEMBER/.test(scope) && /new rationale/.test(scope) && /lawsuit/.test(scope));
  check("scope: not a law firm", /not a law firm/.test(scope));

  const spon = renderInstrument("dfy_sponsor_paid_disclosure", { ...ctx, sponsorRef: "ACME-2026" }).text;
  check("sponsor disclosure carries the reference", spon.includes("ACME-2026"));
  check("sponsor disclosure: engagement runs to the member, no sponsor control", /runs to you, the Member/.test(spon) && /cannot direct what Candid does/.test(spon));
  check("sponsor disclosure: aggregate-only, ≥5", /at least five members/.test(spon));
}

// 4 — channel + expiry + completeness
{
  check("self-funded → ERISA channel", designationChannelFor("employer_self_funded") === "erisa_plan");
  check("public self-funded → ERISA channel", designationChannelFor("employer_self_funded_public") === "erisa_plan");
  check("fully insured → plan internal grievance", designationChannelFor("commercial_fully_insured") === "plan_internal_grievance");
  check("unknown → plan internal grievance (the narrower authority)", designationChannelFor(null) === "plan_internal_grievance");
  check("expiry = one year", defaultExpiryDate(new Date(Date.UTC(2026, 8, 1))) === "2027-09-01");
  const refs = { dfy_authorization_hipaa_cmia: { eventId: "e1", documentId: "d1", signedName: "M", signedAt: "x", hash: "h", version: "1.0" } };
  check("partial paper is incomplete", !paperComplete("member_paid", refs));
  const full = Object.fromEntries(requiredDfyConsents("member_paid").map((t) => [t, { eventId: t, documentId: null, signedName: "M", signedAt: "x", hash: "h", version: "1.0" }]));
  check("all five present is complete", paperComplete("member_paid", full));
  check("a member-paid stack does not complete the sponsor lane", !paperComplete("sponsor_paid", full));
  check("signedInstruments ignores junk values", Object.keys(signedInstruments({ a: 1, b: "x", c: { eventId: 2 } })).length === 0);
}

console.log(`dfy-paper: ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
