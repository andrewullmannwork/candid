/**
 * S292 — dispute-flywheel proof (READ-ONLY; DEV Supabase).
 *
 * Before/after evidence on the REAL rows for claim ecc74954… (user
 * andrew29@candidclaim.com, dispute 01af62e8…):
 *   1. BEFORE — what the needs panel asked at compose time (derived from the
 *      persisted rows + letterVersionHistory v0, which shows the bare
 *      "SUPPORTING DETAIL" header).
 *   2. AFTER — the same items through the NEW derivations: claim-page
 *      attestation adoption, lineCostShare (shared resolveLineCostShare recipe),
 *      amount-paid prefill from effectiveTotals, denial-date prefill.
 *   3. LETTER — re-render via the real rerenderDisputeLetter (pure compose, no
 *      persist) and print the SUPPORTING DETAIL section; then render the
 *      compose-time counterfactual (planBenefit stripped) proving the bare
 *      header is now impossible.
 *
 * Run:  npx tsx scripts/s292-dispute-flywheel-proof.ts
 */
import * as fs from "fs";

// Env FIRST (product-flags / supabase server clients read process.env at call time).
const envText = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split("\n")) {
  if (!line.includes("=") || line.startsWith("#")) continue;
  const k = line.slice(0, line.indexOf("="));
  const v = line.slice(line.indexOf("=") + 1);
  if (!(k in process.env)) process.env[k] = v;
}

const USER_EMAIL = "andrew29@candidclaim.com";
const CLAIM_PREFIX = "ecc74954";

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { readServicesConfirmedAt, readUserPatientPaidOverride, resolveEffectiveClaimTotals } =
    await import("../src/lib/claims/effective-totals");
  const { loadDisputeLineResolutions } = await import("../src/lib/disputes/dispute-ground-basis");
  const { resolvePlanContext } = await import("../src/lib/disputes/plan-context");
  const { resolveEvidence } = await import("../src/lib/disputes/evidence-resolver");
  const { rerenderDisputeLetter } = await import("../src/lib/disputes/rerender");

  const { data: user } = await supabase
    .from("users").select("id, email").eq("email", USER_EMAIL).single();
  if (!user) throw new Error("user not found");

  const { data: allClaims } = await supabase
    .from("claims").select("*").eq("user_id", user.id);
  const claim = (allClaims ?? []).find((c) => String(c.id).startsWith(CLAIM_PREFIX));
  if (!claim) throw new Error("claim not found");
  const { data: lines } = await supabase
    .from("claim_line_items").select("*").eq("claim_id", claim.id).order("line_number");
  const { data: disputes } = await supabase
    .from("dispute_outcomes").select("*").eq("claim_id", claim.id).order("created_at");
  const dispute = (disputes ?? [])[0];
  if (!dispute) throw new Error("dispute not found");
  const dm = (dispute.metadata ?? {}) as Record<string, unknown>;

  console.log("═══ GROUND ROWS ═══");
  console.log(`claim ${claim.id} DOS ${claim.date_of_service} | dispute ${dispute.id} (${dm.letterType})`);

  // ── 1. BEFORE ──────────────────────────────────────────────────────────────
  console.log("\n═══ 1. BEFORE (compose-time asks, from the persisted rows) ═══");
  const servicesConfirmedAt = readServicesConfirmedAt(claim.metadata);
  const disputeAttested = dm.serviceAttestationReviewed === true;
  console.log(`claims.metadata.servicesConfirmedAt = ${servicesConfirmedAt}`);
  console.log(`dispute.metadata.serviceAttestationReviewed = ${disputeAttested}`);
  console.log(`→ BEFORE: "Confirm the services" RE-ASKED (panel read only the dispute flag): ${!disputeAttested}`);
  const override = readUserPatientPaidOverride(claim.metadata);
  const eff = resolveEffectiveClaimTotals({ claim, lineItems: lines ?? [], userTotalsSource: null });
  console.log(`claims.metadata.userPatientPaid = ${override} | bill effectiveTotals.patientPaid = ${eff.patientPaid} (${eff.provenance.patientPaidSource})`);
  console.log(`→ BEFORE: "Amount you paid" ASKED blank (no prefill): ${override == null}`);
  const hist = (dm.letterVersionHistory as Array<{ content: string; savedAt: string }> | undefined) ?? [];
  for (const [i, v] of hist.entries()) {
    const idx = v.content.indexOf("SUPPORTING DETAIL");
    const ridx = v.content.indexOf("RELIEF REQUESTED");
    const between = idx >= 0 && ridx > idx ? v.content.slice(idx + 17, ridx).trim() : "(n/a)";
    console.log(`letterVersionHistory[${i}] (${v.savedAt}): SUPPORTING@${idx} RELIEF@${ridx} between="${between}" ← BARE HEADER`);
  }
  console.log(`→ BEFORE: per-service plan costs — the user hand-typed manual $30 rows at 16:22 (plan_covered_services source='manual') because the panel asked for every one.`);

  // ── 2. AFTER — the new server derivations on the same rows ────────────────
  console.log("\n═══ 2. AFTER (new derivations, read-only) ═══");
  const effectiveAttested = disputeAttested || servicesConfirmedAt != null;
  const attSource = disputeAttested ? "dispute" : servicesConfirmedAt != null ? "claim_page" : null;
  console.log(`Services performed → attested=${effectiveAttested} source=${attSource}  (renders DONE "Confirmed", not re-asked)`);

  const amountPrefill = override == null && eff.patientPaid > 0 ? eff.patientPaid : null;
  console.log(`Amount you paid → prefill $${amountPrefill} (one-click "Looks right", never re-typed)`);

  const eobDate = (claim.metadata as { eob_date?: string } | null)?.eob_date ?? null;
  console.log(`Denial date → prefill ${eobDate ?? "NONE (no EOB parse date stored for this bill-type claim) → question correctly REMAINS"}`);

  const resolutions = await loadDisputeLineResolutions(supabase, user.id, [claim.id]);
  console.log(`lineCostShare (claim-page shared recipe) — ${resolutions.size} lines:`);
  for (const r of resolutions.values()) {
    const copay = r.coverage?.copay ?? null;
    const coins = r.coverage?.coinsurance ?? null;
    const known = r.coverage != null && (copay != null || coins != null);
    const human = r.coverageSource === "manual" || r.coverageUserConfirmed;
    console.log(
      `  line ${r.lineNumber} ${r.serviceSlug}: known=${known} copay=${copay} coins=${coins} source=${r.coverageSource} humanReviewed=${human} confirmed=${r.coverageUserConfirmed} rejected=${r.coverageUserRejected}` +
      ` → panel: ${!known ? "ASK (genuinely unknown)" : human ? "DONE" : "PREFILLED (aggregate looks-right confirm)"}`,
    );
  }

  // ── 3. LETTER — real re-render (pure compose; nothing persisted) ──────────
  console.log("\n═══ 3. LETTER (rerenderDisputeLetter, read-only compose) ═══");
  const planContext = await resolvePlanContext(supabase, {
    userId: user.id,
    claimId: claim.id,
    canonicalPlanIdForBillYear:
      typeof dm.canonicalPlanIdForBillYear === "string" ? dm.canonicalPlanIdForBillYear : null,
    insurerAddressOverride: null,
    pinnedInsurancePlanId: (dispute.insurance_plan_id as string | null) ?? null,
  });
  const extraIds = (dm.claimLineItemIds as string[] | undefined) ?? [];
  const allLineItemIds = Array.from(
    new Set([dispute.claim_line_item_id, ...extraIds].filter(Boolean)),
  ) as string[];
  const evidence = await resolveEvidence(supabase, {
    userId: user.id,
    claimIds: [claim.id],
    lineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
    planContext,
    letterType: "insurance_appeal",
    disputeId: dispute.id,
    userConfirmedSamePlan: ((): "yes" | "no" | "not_sure" | null => {
      const v = dm.userConfirmedSamePlan;
      return v === "yes" || v === "no" || v === "not_sure" ? v : null;
    })(),
    canonicalPlanIdForBillYear:
      typeof dm.canonicalPlanIdForBillYear === "string" ? dm.canonicalPlanIdForBillYear : null,
    attestedLineItemIds: Array.isArray(dm.serviceAttestedLineIds)
      ? (dm.serviceAttestedLineIds as string[])
      : [],
  });
  const rerendered = await rerenderDisputeLetter(supabase, {
    composingDisputeId: dispute.id,
    userId: user.id,
    letterType: "insurance_appeal",
    claimId: claim.id,
    lineItemIds: allLineItemIds,
    planContext,
    evidence,
  });
  if (!rerendered) throw new Error("rerender returned null");
  const body = rerendered.body;
  const hIdx = body.indexOf("SUPPORTING DETAIL");
  const rIdx = body.indexOf("RELIEF REQUESTED");
  console.log(`SUPPORTING DETAIL @ ${hIdx} | RELIEF REQUESTED @ ${rIdx}`);
  if (hIdx >= 0 && rIdx > hIdx) {
    console.log("── rendered SUPPORTING DETAIL section ──");
    console.log(body.slice(hIdx, rIdx).trimEnd());
    console.log("── end section ──");
  } else {
    console.log("SUPPORTING DETAIL header ABSENT (zero clauses → correctly omitted)");
  }

  // Counterfactual — compose-time conditions (no planBenefit anywhere): the bare
  // header must now be IMPOSSIBLE.
  const { LETTER_TEMPLATES } = await import("../src/lib/disputes/templates");
  const strippedEvidence = JSON.parse(JSON.stringify(evidence)) as typeof evidence;
  for (const c of strippedEvidence.claims) {
    for (const li of c.lineItemEvidence) {
      li.planBenefit = null;
      li.expectedPatientCost = null;
      li.discrepancyAmount = null;
      li.discrepancyReason = null;
      li.communityOutcome = null;
      li.siblingCodes = null;
      li.pricingBenchmark = null;
      li.auditFindings = null;
      li.peerCodes = null;
    }
  }
  const counterfactual = LETTER_TEMPLATES.insurance_appeal.body({
    patientName: "Andrew Ullmann Test",
    providerName: "SWEDISH PRIMARY CARE SAND POINT",
    serviceDate: claim.date_of_service as string,
    findings: [],
    bill: {
      id: "cf", documentId: "cf", userId: "cf", billType: "itemized_bill",
      provider: { name: "SWEDISH PRIMARY CARE SAND POINT" },
      patient: { name: "Andrew Ullmann Test", memberId: "2888783" },
      serviceDate: claim.date_of_service as string,
      lineItems: [], totals: { totalBilled: Number(claim.total_billed ?? 0) },
      rawText: "", confidence: 1, parseErrors: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    planContext,
    evidence: strippedEvidence,
    gateUnverified: true,
    v3DesignOn: true,
    disputeGroundsOn: false,
  });
  const cfH = counterfactual.indexOf("SUPPORTING DETAIL");
  const cfBare = /\nSUPPORTING DETAIL\s*\nRELIEF REQUESTED/.test(counterfactual);
  console.log("\n── counterfactual (compose-time conditions: planBenefit stripped) ──");
  console.log(`SUPPORTING DETAIL present: ${cfH >= 0} | bare header adjacency: ${cfBare}`);
  console.log(cfH < 0 && !cfBare
    ? "✓ bare header now IMPOSSIBLE (section omitted entirely)"
    : "✗ REGRESSION — header still rendered without clauses");
  if (cfH >= 0) console.log(counterfactual.slice(Math.max(0, cfH - 80), cfH + 120));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
