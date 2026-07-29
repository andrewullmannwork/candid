/**
 * S293 #6 — READ-ONLY pipeline probe on andrewullmanntest292@candidclaim.com.
 *
 * Runs BOTH derivations the product runs, side by side, on the real rows:
 *   A. PANEL path — loadDisputeLineResolutions (resolveLineCostShare, the claim
 *      page's shared recipe) → what the needs panel showed + the user confirmed.
 *   B. LETTER path — resolveEvidence → per-line planBenefit → what
 *      renderLineItemEvidence produces (via a real template compose).
 *
 * Proves where the user's aggregate "Looks right" confirmation stops flowing.
 * No writes anywhere. Run: npx tsx scripts/s293-probe-test292-pipeline.ts
 */
import * as fs from "fs";

const envText = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split("\n")) {
  if (!line.includes("=") || line.startsWith("#")) continue;
  const k = line.slice(0, line.indexOf("="));
  if (!(k in process.env)) process.env[k] = line.slice(line.indexOf("=") + 1);
}

const USER_ID = "50b6d42c-5a80-4c1a-9f22-a1c72c81f3c6";
const CLAIM_ID = "146b1b9f-1fc0-40f4-8004-3b576581d284";
const DISPUTE_ID = "80a705ac-485d-4fc1-a940-3ac8f7d6ffd0";
const PLAN_ID = "7d8f5e3d-162f-412a-bb69-41a0a570f659";

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { isFeatureEnabled } = await import("../src/lib/config/product-flags");
  const { loadDisputeLineResolutions } = await import("../src/lib/disputes/dispute-ground-basis");
  const { resolvePlanContext } = await import("../src/lib/disputes/plan-context");
  const { resolveEvidence } = await import("../src/lib/disputes/evidence-resolver");

  console.log("═══ FLAGS (DEV) ═══");
  for (const f of [
    "recovery_cost_share_v2", "secondary_coverage_v2", "dispute_grounds_v1",
    "cite_grade_gate_v1", "dispute_letters_v3_design",
  ]) {
    console.log(`  ${f}: ${await isFeatureEnabled(f)}`);
  }

  console.log("\n═══ plan_covered_services for plan", PLAN_ID, "═══");
  const pcsQ = await supabase
    .from("plan_covered_services")
    .select("service_slug, covered, in_copay, in_coinsurance, source, confidence")
    .eq("insurance_plan_id", PLAN_ID);
  console.log("error:", pcsQ.error?.message ?? "none", "| rows:", pcsQ.data?.length ?? 0);
  for (const r of pcsQ.data ?? []) console.log(" ", JSON.stringify(r));

  console.log("\n═══ canonical_plan_services for canonical 7de9bd87… (count only) ═══");
  const cpsQ = await supabase
    .from("canonical_plan_services")
    .select("service_slug, covered, in_copay, in_coinsurance", { count: "exact", head: false })
    .eq("canonical_plan_id", "7de9bd87-24b3-44f9-9b78-d2df4c42f174")
    .limit(60);
  console.log("error:", cpsQ.error?.message ?? "none", "| rows:", cpsQ.data?.length ?? 0);
  const slugs = ["pcp_visit", "annual_physical", "immunizations", "preventive_care"];
  for (const r of cpsQ.data ?? []) {
    if (slugs.includes(r.service_slug as string)) console.log("  [claim slug]", JSON.stringify(r));
  }

  // ── A. PANEL path ──────────────────────────────────────────────────────────
  console.log("\n═══ A. PANEL path — loadDisputeLineResolutions ═══");
  const resolutions = await loadDisputeLineResolutions(supabase, USER_ID, [CLAIM_ID]);
  for (const r of resolutions.values()) {
    console.log(
      `  line ${r.lineNumber} ${r.serviceSlug}: coverage=${JSON.stringify(r.coverage)} ` +
      `source=${r.coverageSource} secondary=${r.secondaryMatchedSlug}/${r.secondaryConfidence} ` +
      `confirmed=${r.coverageUserConfirmed} rejected=${r.coverageUserRejected} verdict=${r.result.verdict}`,
    );
  }

  // ── B. LETTER path — resolveEvidence (exactly as redraft does) ────────────
  console.log("\n═══ B. LETTER path — resolveEvidence per-line planBenefit ═══");
  const { data: dispute } = await supabase
    .from("dispute_outcomes").select("*").eq("id", DISPUTE_ID).single();
  const dm = (dispute!.metadata ?? {}) as Record<string, unknown>;
  const planContext = await resolvePlanContext(supabase, {
    userId: USER_ID,
    claimId: CLAIM_ID,
    canonicalPlanIdForBillYear:
      typeof dm.canonicalPlanIdForBillYear === "string" ? dm.canonicalPlanIdForBillYear : null,
    insurerAddressOverride: null,
    pinnedInsurancePlanId: (dispute!.insurance_plan_id as string | null) ?? null,
  });
  console.log("planContext.plan:", planContext.plan ? `${planContext.plan.id} (${planContext.plan.planName}, year ${planContext.plan.planYear})` : null);
  console.log("planContext.fallbackPlan:", planContext.fallbackPlan?.id ?? null);

  const extraIds = (dm.claimLineItemIds as string[] | undefined) ?? [];
  const allLineItemIds = Array.from(
    new Set([dispute!.claim_line_item_id, ...extraIds].filter(Boolean)),
  ) as string[];
  const evidence = await resolveEvidence(supabase, {
    userId: USER_ID,
    claimIds: [CLAIM_ID],
    lineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
    planContext,
    letterType: "insurance_appeal",
    disputeId: DISPUTE_ID,
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
  for (const c of evidence.claims) {
    for (const li of c.lineItemEvidence) {
      console.log(
        `  ${li.serviceName} (${li.serviceSlug}): planBenefit=${li.planBenefit ? JSON.stringify({ covered: li.planBenefit.covered, copay: li.planBenefit.copay, coins: li.planBenefit.coinsurance, sourcedFrom: li.planBenefit.sourcedFrom, verified: li.planBenefit.sbcExcerptVerified }) : null}` +
        ` insPaid=${li.insurancePaid} patOwes=${li.patientOwes} billed=${li.billedAmount}` +
        ` community=${li.communityOutcome != null} siblings=${li.siblingCodes != null} pricing=${li.pricingBenchmark != null}` +
        ` audit=${li.auditFindings?.length ?? 0} peers=${li.peerCodes?.length ?? 0} attested=${li.serviceNotRenderedAttested}` +
        ` secondaryVerifyGate=${li.secondaryCoverageVerify != null}`,
      );
    }
  }
  console.log("evidence gaps:", evidence.gaps.map((g) => g.kind).join(", ") || "(none)");

  // ── C. Full compose (pure — nothing persisted): the letter as ?refresh=1
  //      would now regenerate it. Prints the evidence section verbatim. ──────
  console.log("\n═══ C. COMPOSED LETTER (rerenderDisputeLetter, read-only) ═══");
  const { rerenderDisputeLetter } = await import("../src/lib/disputes/rerender");
  const rerendered = await rerenderDisputeLetter(supabase, {
    disputeId: DISPUTE_ID,
    userId: USER_ID,
    letterType: "insurance_appeal",
    claimId: CLAIM_ID,
    lineItemIds: allLineItemIds,
    planContext,
    evidence,
  });
  if (!rerendered) throw new Error("rerender returned null");
  const body = rerendered.body;
  for (const title of ["SUPPORTING DETAIL", "WHY THIS SERVICE SHOULD BE COVERED"]) {
    const h = body.indexOf(title);
    if (h >= 0) {
      const r = body.indexOf("RELIEF REQUESTED");
      console.log(`── section "${title}" ──`);
      console.log(body.slice(h, r > h ? r : h + 1200).trimEnd());
      console.log("── end section ──");
    }
  }
  if (!body.includes("SUPPORTING DETAIL") && !body.includes("WHY THIS SERVICE SHOULD BE COVERED")) {
    console.log("NO evidence section rendered — invariant violated");
    process.exit(1);
  }
  console.log(`"Source: ." fragment present: ${body.includes("Source: .")}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
