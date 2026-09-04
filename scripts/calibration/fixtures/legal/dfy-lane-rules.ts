/**
 * dfy-lane-rules — S330. Locks the pure rules of the rest of the lane:
 *   - sponsors: paper before code (a code is usable only with a signed,
 *     active agreement); the aggregate report suppresses below the floor and
 *     folds sub-floor cells into "other" — never a member-level row
 *   - fees: the three-business-day cancel window; what is refundable
 *   - SLA: which live matters get a nudge, and why
 *   - the access review is weekly (stale after 7 days or never)
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/dfy-lane-rules.ts
 */
import { sponsorCodeUsable, buildSponsorReport, normalizeSponsorCode, type DfySponsor } from "../../../../src/lib/dfy/sponsors";
import { memberIsEligibleToSign, instrumentDeferral } from "../../../../src/lib/dfy/sign";
import { DFY_CONFIG_DEFAULTS } from "../../../../src/lib/dfy/config";
import { withinCancelWindow, refundable, businessDaysSinceSigned } from "../../../../src/lib/dfy/fees";
import { slaFlags } from "../../../../src/lib/dfy/sla";
import { accessReviewStale, parseDfyConfig } from "../../../../src/lib/dfy/config";
import type { MatterSummary } from "../../../../src/lib/dfy/matter";
import type { DfyEngagementRow } from "../../../../src/lib/security/operator-scoped";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } }

// ── sponsors ──
const sponsor: DfySponsor = { id: "s1", code: "ACME-2026", name: "Acme", contact_email: null, agreement_signed_at: "2026-08-30T00:00:00Z", active: true, terms: {}, created_at: "", updated_at: "" };
check("signed + active code is usable", sponsorCodeUsable(sponsor).ok);
check("unsigned agreement is NOT usable (paper before code)", !sponsorCodeUsable({ ...sponsor, agreement_signed_at: null }).ok);
check("inactive sponsor is NOT usable", !sponsorCodeUsable({ ...sponsor, active: false }).ok);
check("unknown code is NOT usable", !sponsorCodeUsable(null).ok);
check("codes normalize", normalizeSponsorCode(" acme-2026 ") === "ACME-2026");
{
  const rows = (n: number, status = "active") => Array.from({ length: n }, () => ({ status, determination: null as string | null }));
  const small = buildSponsorReport(sponsor, rows(4));
  check("under the floor: suppressed, no cells", small.suppressed && small.byStatus === null && small.total === 0);
  const big = buildSponsorReport(sponsor, [...rows(6, "active"), ...rows(2, "completed"), ...rows(1, "terminated")]);
  check("at/over the floor: total published", !big.suppressed && big.total === 9);
  check("cells under the floor fold into other", big.byStatus?.active === 6 && big.byStatus?.other === 3 && big.byStatus?.completed === undefined);
  const det = buildSponsorReport(sponsor, [...rows(5).map((r) => ({ ...r, determination: "denied" })), ...rows(2).map((r) => ({ ...r, determination: "approved" }))]);
  check("determinations fold the same way", det.byDetermination?.denied === 5 && det.byDetermination?.other === 2);
}

// ── fees ──
{
  const signed = "2026-09-01T18:00:00Z"; // Tue
  check("same day: within window", withinCancelWindow(signed, new Date(Date.UTC(2026, 8, 1, 20))));
  check("3 business days later (Fri): within window", withinCancelWindow(signed, new Date(Date.UTC(2026, 8, 4, 12))));
  check("4 business days later (Mon): outside window", !withinCancelWindow(signed, new Date(Date.UTC(2026, 8, 7, 12))));
  check("weekend does not count", businessDaysSinceSigned(signed, new Date(Date.UTC(2026, 8, 6, 12))) === 3);
  check("unsigned: not within window", !withinCancelWindow(null, new Date()));
  check("succeeded + unrefunded is refundable", refundable({ status: "succeeded", intentId: "pi_1", amountCents: 500 }));
  check("already refunded is not", !refundable({ status: "succeeded", intentId: "pi_1", amountCents: 500, refund: { id: "re_1", amountCents: 500, at: "x", basis: "operator_discretion", by: null } }));
  check("free pilot (0 cents) is not refundable", !refundable({ status: "succeeded", intentId: "pi_1", amountCents: 0 }));
  check("no payment is not refundable", !refundable(null));
}

// ── SLA ──
{
  const base: DfyEngagementRow = { id: "e1", user_id: "m1", claim_id: "c1", status: "active", lane: "insurer", payer: "member_paid", sponsor_ref: null, sponsor_id: null, operator_user_id: "u1", member_state: "CA", plan_classification: null, scope: {}, intake: {}, consent_event_ids: {}, metadata: {}, signed_at: "2026-08-20T00:00:00Z", activated_at: "2026-08-20T00:00:00Z", closed_at: null, created_at: "", updated_at: "" };
  const summary = (over: Partial<MatterSummary>, e: Partial<DfyEngagementRow> = {}): MatterSummary => ({
    engagement: { ...base, ...e }, submittablePaper: [], member: { userId: "m1", displayName: null, email: null, state: "CA" }, holder: null,
    composition: { groundSelected: true, letterAdopted: true }, insurerLetter: null, runwayBusinessDays: 30, events: [], lastAct: { id: null, kind: "dfy_status_called", occurredAt: "2026-08-31T00:00:00Z", disputeId: null, payload: {} }, phase: "x", ...over,
  });
  const now = new Date(Date.UTC(2026, 8, 1, 12));
  const cfg = { refusalRunwayBusinessDays: 10, slaDays: 3 };
  check("healthy matter: no flag", slaFlags([summary({})], cfg, now).length === 0);
  check("runway under threshold flags", slaFlags([summary({ runwayBusinessDays: 4 })], cfg, now)[0]?.reasons.some((r) => /runway/.test(r)) === true);
  check("no act for 3+ days flags", slaFlags([summary({ lastAct: { id: null, kind: "dfy_status_called", occurredAt: "2026-08-25T00:00:00Z", disputeId: null, payload: {} } })], cfg, now)[0]?.reasons.some((r) => /no operator act/.test(r)) === true);
  check("unclaimed signed matter flags", slaFlags([summary({}, { status: "signed", operator_user_id: null })], cfg, now)[0]?.reasons.some((r) => /unclaimed/.test(r)) === true);
  check("closed matters never flag", slaFlags([summary({ runwayBusinessDays: 1 }, { status: "completed" })], cfg, now).length === 0);
}

// ── access review ──
{
  check("never reviewed is stale", accessReviewStale(parseDfyConfig({}), new Date()));
  const fresh = parseDfyConfig({ access_review: { at: new Date(Date.now() - 2 * 86_400_000).toISOString(), by: "a@b" } });
  check("reviewed 2 days ago is fresh", !accessReviewStale(fresh, new Date()));
  const old = parseDfyConfig({ access_review: { at: new Date(Date.now() - 9 * 86_400_000).toISOString(), by: "a@b" } });
  check("reviewed 9 days ago is stale", accessReviewStale(old, new Date()));
  check("entry point defaults OFF", parseDfyConfig({}).entryPointEnabled === false);
  check("fee defaults to 0 (free pilot)", parseDfyConfig({}).feeCents === 0);
}

// ── sign-first (S330, Andrew #4): the pen is open until a DECLINE; the designation waits for its person ──
{
  const base = { id: "e", user_id: "u", claim_id: "c", status: "eligibility_pending", lane: "insurer", payer: "member_paid", sponsor_ref: null, sponsor_id: null, operator_user_id: null, member_state: "CA", plan_classification: { coverageType: "erisa_plan" }, scope: {}, intake: {}, consent_event_ids: {}, metadata: {}, created_at: "x", updated_at: "x", screened_at: null, signed_at: null, activated_at: null, closed_at: null } as unknown as DfyEngagementRow;
  check("unscreened is signable", memberIsEligibleToSign(base));
  check("declined is not signable", !memberIsEligibleToSign({ ...base, intake: { decision: { eligible: false } } }));
  check("eligible is signable", memberIsEligibleToSign({ ...base, intake: { decision: { eligible: true } } }));
  check("a complete stack (status signed) is not re-signable", !memberIsEligibleToSign({ ...base, status: "signed" }));
  const ind = { ...DFY_CONFIG_DEFAULTS, designationNamedParty: { erisa_plan: "individual" as const, plan_internal_grievance: "individual" as const } };
  check("the DEFAULT names the entity, so nothing defers out of the box (Andrew, S330)", DFY_CONFIG_DEFAULTS.designationNamedParty.erisa_plan === "entity" && DFY_CONFIG_DEFAULTS.designationNamedParty.plan_internal_grievance === "entity" && instrumentDeferral("dfy_authorized_representative_designation", base, DFY_CONFIG_DEFAULTS) === null);
  check("designation defers with no operator under individual naming", typeof instrumentDeferral("dfy_authorized_representative_designation", base, ind) === "string");
  check("designation opens once an operator holds the matter", instrumentDeferral("dfy_authorized_representative_designation", { ...base, operator_user_id: "op" }, ind) === null);
  const ent = { ...DFY_CONFIG_DEFAULTS, designationNamedParty: { erisa_plan: "entity" as const, plan_internal_grievance: "entity" as const } };
  check("entity naming never defers", instrumentDeferral("dfy_authorized_representative_designation", base, ent) === null);
  check("other instruments never defer", instrumentDeferral("dfy_fee_agreement", base, ind) === null && instrumentDeferral("dfy_authorization_hipaa_cmia", base, ind) === null);
}

console.log(`dfy-lane-rules: ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
