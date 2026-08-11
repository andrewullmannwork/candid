/**
 * S309 — headless math verification for one claim (default: 696a7c07, the
 * Swedish Breast Imaging fresh bill). Replicates /api/claims/[claimId]'s
 * cost-share assembly via the SAME shared recipes (resolveLinePrep +
 * resolveCostShareForLine) so every printed dollar is the engine's own output,
 * not re-derived arithmetic. Read-only. DEV-gated. Zero writes.
 *
 * Run: npx tsx scripts/s309-math-verify.ts [claimId]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpkmgezhvlmaumhwqua")) {
  console.error(`REFUSING: ${new URL(url).host} is not DEV.`);
  process.exit(1);
}
const sb = createClient(url, key);
const CLAIM = process.argv[2] ?? "696a7c07-e4ac-46c2-9dbe-d53176eaa586";

async function main() {
  // Env-first rule (s292/s293 precedent): src modules imported AFTER dotenv.
  const { isFeatureEnabled } = await import("../src/lib/config/product-flags");
  const {
    loadPlanCostShareParams,
    mapRawAccumulator,
    loadCostShareOverrides,
    resolveOverridesForBill,
    loadCostShareGate,
    coerceNetworkTier,
    coerceNetworkOverride,
  } = await import("../src/lib/claims/cost-share-loader");
  const { resolveCostShareForLine, resolveLinePrep } = await import(
    "../src/lib/claims/resolve-cost-share"
  );
  const { resolveEffectiveClaimTotals, readUserTotalsSource, readUserPatientPaidOverride, applyUserPatientPaidOverride } =
    await import("../src/lib/claims/effective-totals");
  const { buildAcaCoverageFallback, detectPreventiveMembership } = await import(
    "../src/lib/audit/aca-coverage-fallback"
  );
  const { loadSecondaryGate, loadPlanCoverageMeta, DEFAULT_SECONDARY_GATE } = await import(
    "../src/lib/audit/coverage-loader"
  );

  const { data: claim, error: e1 } = await sb.from("claims").select("*").eq("id", CLAIM).single();
  if (e1 || !claim) throw new Error("claim: " + (e1?.message ?? "not found"));
  const planId = claim.insurance_plan_id as string | null;
  const userId = claim.user_id as string;

  const { data: rawLines, error: e2 } = await sb
    .from("claim_line_items")
    .select("*")
    .eq("claim_id", CLAIM);
  if (e2) throw new Error("lines: " + e2.message);
  const lineItems = [...(rawLines ?? [])].sort((a, b) => {
    const an = a.line_number == null ? Infinity : Number(a.line_number);
    const bn = b.line_number == null ? Infinity : Number(b.line_number);
    return an - bn;
  });

  // ── flags + gates (route lines 149-164) ──
  const secondaryV2 = await isFeatureEnabled("secondary_coverage_v2");
  const secondaryGate = secondaryV2 ? await loadSecondaryGate(sb) : DEFAULT_SECONDARY_GATE;
  const costShareV2 = await isFeatureEnabled("recovery_cost_share_v2");
  const csHonestyGate = costShareV2 ? await isFeatureEnabled("unverified_plan_honesty_gate_v1") : false;
  console.log("■ FLAGS  secondary_coverage_v2:", secondaryV2, "| recovery_cost_share_v2:", costShareV2, "| honesty_gate:", csHonestyGate);
  if (!costShareV2) throw new Error("recovery_cost_share_v2 OFF — nothing to verify");

  // ── coverage meta (route 240-288) ──
  const planMeta = planId ? (await loadPlanCoverageMeta(sb, [planId])).get(planId) : undefined;
  const coverageMap = planMeta?.coverageMap ?? new Map();
  const coveredMeta = planMeta?.coveredMeta ?? [];
  const planAcaCompliant: boolean | null = planMeta?.acaCompliant ?? null;

  const billSlugMeta = new Map<string, { category: string | null; isPreventiveEligible: boolean }>();
  const distinctBillSlugs = Array.from(
    new Set(lineItems.map((li) => li.service_slug as string | null).filter((s): s is string => Boolean(s))),
  );
  if (distinctBillSlugs.length > 0) {
    const { data: scMeta } = await sb
      .from("service_catalog")
      .select("slug, category, is_preventive_eligible")
      .in("slug", distinctBillSlugs);
    for (const r of scMeta ?? []) {
      billSlugMeta.set(r.slug as string, {
        category: (r.category as string | null) ?? null,
        isPreventiveEligible: Boolean(r.is_preventive_eligible),
      });
    }
  }

  const acaFallback = await buildAcaCoverageFallback({
    supabase: sb,
    planId,
    userId,
    patientName: (claim.patient_name as string | null | undefined) ?? null,
    lineItems: lineItems.map((li) => ({
      lineNumber: Number(li.line_number ?? 0),
      procedureCode: (li.billing_code as string | null) ?? null,
      procedureCodeType: (li.billing_code_type as string | null) ?? null,
      serviceSlug: (li.service_slug as string | null) ?? null,
    })),
    existingCoverageBySlug: new Set(coverageMap.keys()),
  });

  // ── effective totals (route 290-328) ──
  const claimTotalBilled = Number(claim.total_billed || 0);
  const claimStillOutstanding =
    claim.amount_still_outstanding != null
      ? Number(claim.amount_still_outstanding)
      : claim.total_patient_responsibility != null
        ? Number(claim.total_patient_responsibility)
        : null;
  const ov = readUserPatientPaidOverride((claim as { metadata?: unknown }).metadata);
  if (ov != null) {
    applyUserPatientPaidOverride(
      claim as { total_patient_paid?: number | null },
      lineItems as Array<{ billed_amount?: number | null; patient_paid_amount?: number | null }>,
      ov,
    );
  }
  const effectiveTotals = resolveEffectiveClaimTotals({
    claim,
    lineItems,
    userTotalsSource: readUserTotalsSource(claim.metadata),
  });
  console.log("\n■ EFFECTIVE TOTALS", JSON.stringify(effectiveTotals));

  // ── engine context (route 330-414) ──
  const csGate = await loadCostShareGate(sb);
  const csPlanParams = planId ? await loadPlanCostShareParams(sb, planId) : null;
  const { data: accRaw } = await sb
    .from("claim_accumulators")
    .select("claim_id, benefit_year, network_tier, accumulator_type, is_individual, deductible_applied, deductible_max, oop_applied, oop_max")
    .eq("claim_id", CLAIM);
  const csAccumulatorRows = (accRaw ?? []).map(mapRawAccumulator);
  const csPlanYear = claim.date_of_service
    ? new Date(claim.date_of_service as string).getUTCFullYear()
    : null;
  const rawOverrides = await loadCostShareOverrides(
    sb, userId, planId, csPlanYear, coerceNetworkOverride(claim.user_network_override),
  );
  const csOverrides = resolveOverridesForBill(rawOverrides, (claim.date_of_service as string | null) ?? null);
  const csMemberSums = { deductible: 0, oop: 0 };
  for (const it of lineItems) {
    const r = it as Record<string, unknown>;
    csMemberSums.deductible += Number(r.member_applied_to_deductible ?? 0);
    csMemberSums.oop += Number(r.member_coinsurance ?? 0) + Number(r.member_copay ?? 0);
  }
  const csPreventiveLines = await detectPreventiveMembership({
    supabase: sb,
    userId,
    patientName: (claim.patient_name as string | null | undefined) ?? null,
    lineItems: lineItems.map((li) => ({
      lineNumber: Number(li.line_number ?? 0),
      procedureCode: (li.billing_code as string | null) ?? null,
      procedureCodeType: (li.billing_code_type as string | null) ?? null,
      serviceSlug: (li.service_slug as string | null) ?? null,
    })),
  });
  const csAcaStatus: "confirmed" | "unknown" | "non_aca" =
    planAcaCompliant === true ? "confirmed" : planAcaCompliant === false ? "non_aca" : "unknown";
  const csClaimInsurerPaidZero =
    claim.total_insurance_paid != null && Number(claim.total_insurance_paid) === 0;

  console.log("\n■ PLAN PARAMS", JSON.stringify(csPlanParams));
  console.log("\n■ OVERRIDES raw:", JSON.stringify(rawOverrides));
  console.log("  resolved for bill", claim.date_of_service, ":", JSON.stringify(csOverrides));
  console.log("  planYear:", csPlanYear, "| accRows:", csAccumulatorRows.length, "| memberSums:", JSON.stringify(csMemberSums), "| preventiveLines:", JSON.stringify([...csPreventiveLines]), "| acaStatus:", csAcaStatus, "| insurerPaidZero:", csClaimInsurerPaidZero, "| gate:", JSON.stringify(csGate));

  // ── the raw pcs rows for each bill slug + the map's winner (pickCoverageRow) ──
  console.log("\n■ COVERAGE — raw rows per slug, then the winner the map picked:");
  for (const slug of distinctBillSlugs) {
    const { data: pcsRows } = await sb
      .from("plan_covered_services")
      .select("id, in_copay, in_coinsurance, in_deductible_applies, covered, source, confidence, field_provenance, service_catalog!inner(slug)")
      .eq("insurance_plan_id", planId!)
      .eq("service_catalog.slug", slug);
    for (const r of pcsRows ?? []) {
      console.log(`  [${slug}] row ${String(r.id).slice(0, 8)} copay=${r.in_copay} coins=${r.in_coinsurance} dedApplies=${r.in_deductible_applies} covered=${r.covered} src=${r.source} conf=${r.confidence}`);
    }
    const winner = coverageMap.get(slug);
    console.log(`  → WINNER for ${slug}: ${JSON.stringify(winner)}`);
  }

  // ── per-line prep + engine (route 418-512) ──
  const csCtx = {
    planParams: csPlanParams,
    overrides: csOverrides,
    accRows: csAccumulatorRows,
    memberSums: csMemberSums,
    preventiveLines: csPreventiveLines,
    acaStatus: csAcaStatus,
    claimInsurerPaidZero: csClaimInsurerPaidZero,
    gate: csGate,
    networkClaim: coerceNetworkTier(claim.network_status),
    coverageTier: csPlanParams?.coverageTier ?? null,
    planYear: csPlanYear,
    unverifiedPlanHonestyGate: csHonestyGate,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const csPrepInputs = {
    coverageMap,
    coveredMeta,
    billSlugMeta,
    planAcaCompliant,
    secondaryGate,
    secondaryEnabled: secondaryV2,
    acaFallback,
    claimTotalBilled,
    claimStillOutstanding,
    effectiveTotals,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  console.log("\n■ PER LINE (prep → engine):");
  let pricedShouldOwe = 0;
  let pricedCount = 0;
  for (const item of lineItems) {
    const lp = resolveLinePrep(item as Record<string, unknown>, csPrepInputs, "detail");
    const billed = Number((item as Record<string, unknown>).billed_amount || 0);
    const cs = resolveCostShareForLine(
      {
        lineNumber: Number((item as Record<string, unknown>).line_number ?? 0),
        billed,
        allowed: lp.allowed,
        insuranceAdjusted: lp.insuranceAdjusted,
        patientPaid: lp.patientPaid,
        patientResponsibility: lp.patientResponsibility,
        coverage: lp.coverage,
        exactCoverageMatch: lp.exactCoverageMatch,
        networkStatus: (item as Record<string, unknown>).network_status as string | null,
        raw: item as Record<string, unknown>,
      },
      csCtx,
    );
    const slug = (item as Record<string, unknown>).service_slug;
    console.log(`\n  #${(item as Record<string, unknown>).line_number} ${slug} (${(item as Record<string, unknown>).billing_code_type} ${(item as Record<string, unknown>).billing_code}) billed=${billed}`);
    console.log(`    prep: allowed=${lp.allowed} (src=${lp.insuranceAdjustedSource ?? "—"}) patientPaid=${lp.patientPaid} (src=${lp.patientPaidSource ?? "—"}) patientResp=${lp.patientResponsibility} coverageSource=${lp.coverageSource} exactMatch=${lp.exactCoverageMatch}`);
    console.log(`    coverage: ${JSON.stringify(lp.coverage)}`);
    console.log(`    engine: shouldOwe=${cs.shouldOwe} refund=${cs.refundComponent} forgiveness=${cs.forgivenessComponent} potentialRecovery=${cs.potentialRecovery ?? "—"} verdict=${JSON.stringify(cs.verdict)}`);
    console.log(`    grounded=${(cs as unknown as Record<string, unknown>).shouldOweGrounded} discrepancy=${JSON.stringify(cs.insurerDiscrepancy)}`);
    const assumptions = (cs.assumptions ?? []) as unknown as Array<Record<string, unknown>>;
    console.log(`    assumptions: ${assumptions.map((a) => `${a.field}${a.reason ? `(${a.reason})` : ""}${a.answered ? "[answered]" : ""}`).join(" · ") || "(none)"}`);
    const rateKnown = !assumptions.some((a) => a.field === "service_cost" && !a.answered);
    if (rateKnown) { pricedShouldOwe += Number(cs.shouldOwe ?? 0); pricedCount++; }
  }
  console.log(`\n■ CLAIM ROLLUP  priced lines: ${pricedCount}/${lineItems.length} · summed shouldOwe over priced = ${pricedShouldOwe.toFixed(2)} · header patient_resp = ${claim.total_patient_responsibility} · effectivePatientPaid = ${JSON.stringify(effectiveTotals)}`);
}
main().catch((e) => { console.error("VERIFY FAILED:", e.message, e.stack?.split("\n").slice(1, 4).join("\n")); process.exit(1); });
