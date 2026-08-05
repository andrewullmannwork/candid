// S74.5 D15 — Claim-header arithmetic check.
//
// Per plans/s74.5_categorization_flywheel.md v2 §7.4 + Q-D LOCK ($5 threshold)
// + Q-E LOCK (dismiss affordance + reason logging — UI portion deferred).
//
// Catches the scenario where bill header shows patient owes $X but the line
// items only itemize $Y of that. Andrew's $146 motivating example: 4 line
// items summed to $1,151 patient responsibility but the header showed $1,297
// owed; $146 unallocated.
//
// Flags as finding type "unallocated_balance" when:
//   - bill.totals.totalPatientResponsibility is set (parser confidence proxy)
//   - sum of line patientResponsibility values is set on enough lines
//   - delta > threshold (default $5 per Q-D LOCK; admin-tunable via flag config)
//
// When parser confidence is low (totals undefined, or most lines missing
// patient_resp), the check is skipped (no flag) to avoid false positives.

import { isFeatureEnabled } from "../config/product-flags";
import type { ParsedBill, AuditFinding } from "../billing/types";
import {
  loadVerifierTolerances,
  verifyHeaderReconciliation,
  verifyPerLineSums,
} from "../billing/sum-invariants";
import { randomUUID } from "crypto";

const DEFAULT_THRESHOLD_CENTS = 500; // $5 per Q-D LOCK

interface FlagConfig {
  unallocated_balance_threshold_cents?: number;
}

async function readThresholdCents(): Promise<number> {
  // Inline read to avoid extra import; mirrors readFeatureFlagConfig's logic.
  // Cheap query; runs once per audit pass.
  const { createServerClient } = await import("../supabase/server");
  const supabase = createServerClient();
  const { data } = await supabase
    .from("feature_flag_rules")
    .select("config")
    .eq("flag_key", "s74_5_categorization_flywheel_v1")
    .maybeSingle();
  const cfg = (data?.config ?? null) as FlagConfig | null;
  return cfg?.unallocated_balance_threshold_cents ?? DEFAULT_THRESHOLD_CENTS;
}

/**
 * S304 — the identity path's provenance, distinct from the itemization path's,
 * so downstream (and persist's data-trust suppression) can tell which route
 * produced the finding without re-deriving the condition.
 */
export const IDENTITY_BENCHMARK_SOURCE = "claim_header_identity";

/**
 * S304 — dollars with thousands separators, as the approved copy renders them
 * ("$1,404.00", not "$1404.00"). Magnitude only: every figure in this finding is
 * a positive amount by construction. Path 1's copy predates this and keeps its
 * own `toFixed(2)` rather than being silently reworded.
 */
function usd(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Both paths end here — one finding shape, one severity ladder, one threshold. */
function buildFinding(args: {
  unallocated: number;
  totalBilled: number;
  title: string;
  description: string;
  benchmarkSource: string;
  arithmeticGap?: AuditFinding["arithmeticGap"];
}): AuditFinding {
  return {
    id: randomUUID(),
    type: "unallocated_balance",
    severity:
      args.unallocated >= 250 ? "high" : args.unallocated >= 50 ? "medium" : "low",
    lineItems: [], // claim-header finding spans the bill, not specific lines
    title: args.title,
    description: args.description,
    estimatedOvercharge: args.unallocated,
    benchmarkSource: args.benchmarkSource,
    ...(args.arithmeticGap ? { arithmeticGap: args.arithmeticGap } : {}),
    billedAmount: args.totalBilled,
    confidence: 0.75,
    actionable: true,
  };
}

export async function runClaimHeaderArithmeticCheck(
  bill: ParsedBill,
): Promise<AuditFinding[]> {
  const flagOn = await isFeatureEnabled("s74_5_categorization_flywheel_v1");
  if (!flagOn) return [];

  const headerPatientResp = bill.totals.totalPatientResponsibility;
  if (headerPatientResp == null || headerPatientResp <= 0) return [];

  // Additional proxy: if header totalBilled is missing entirely we have low
  // confidence on the header totals at all — skip.
  const totalBilled = bill.totals.totalBilled;
  if (totalBilled == null || totalBilled <= 0) return [];

  const linesWithPatientResp = bill.lineItems.filter(
    (li) => li.patientResponsibility != null,
  );

  // ── Path 2 (S304) — the bill's own arithmetic doesn't close ───────────────
  //
  // Reached ONLY when no line carries a responsibility figure, which is where
  // this check previously gave up entirely ("parser likely couldn't extract").
  // After S304 that reading is wrong: a provider itemised receipt states its
  // adjudication ONCE, in the summary block, and the parser is instructed to
  // emit null per line. Those bills are not unreadable — they are complete, and
  // their header alone is enough to test the accounting identity:
  //
  //   billed − ins_adjusted − provider_adjusted − contract_discount
  //          − insurance_paid  =  patient_responsibility
  //
  // Path 1 asks "do the LINES itemise everything the header says you owe?".
  // This asks "do the bill's own REDUCTIONS reconcile to what it charged?".
  // Different questions, same answer when they fail — money charged to the
  // patient that the bill does not account for — so they share a finding type,
  // a dispute ground, a recovery pool and a threshold.
  //
  // The two are mutually exclusive BY CONSTRUCTION (path 1 needs ≥1 line with a
  // figure, this needs 0), stated as an explicit branch so it cannot drift into
  // both firing on one bill.
  if (linesWithPatientResp.length === 0) {
    const tolerances = await loadVerifierTolerances();
    const header = verifyHeaderReconciliation(bill, tolerances);
    // Every term of the identity must be present. Missing terms mean we cannot
    // say the bill is wrong — only that we cannot check it.
    if (!header.allHeaderTotalsPresent || header.withinTolerance) return [];

    // The discriminator: do the individual charges add up to the bill's own
    // total charge? If yes, our reading of the document is verified against the
    // document itself, so a residual is the DOCUMENT's error, not ours. If no,
    // we may have misread a line — that stays a data-trust matter and the
    // reconciliation verdict handles it.
    const billedVerdict = verifyPerLineSums(bill, tolerances).find(
      (v) => v.perLineKey === "billedAmount",
    );
    if (!billedVerdict?.populated || !billedVerdict.withinTolerance) return [];

    // residual < 0 ⇒ patient responsibility exceeds what the charge minus the
    // reductions leaves ⇒ they were billed beyond what the bill accounts for.
    // The other direction (unassigned charge) is not an overcharge; leave it.
    const unallocated = header.residual < 0 ? Math.round(-header.residual * 100) / 100 : 0;
    if (unallocated <= 0) return [];

    const thresholdCents = await readThresholdCents();
    if (Math.round(unallocated * 100) < thresholdCents) return [];

    const reductions = [
      bill.totals.totalInsAdjusted != null
        ? `the insurer's ${usd(bill.totals.totalInsAdjusted)} adjustment`
        : null,
      bill.totals.totalProviderAdjusted != null
        ? `a ${usd(bill.totals.totalProviderAdjusted)} provider adjustment`
        : null,
      bill.totals.totalContractDiscount != null
        ? `a ${usd(bill.totals.totalContractDiscount)} contract discount`
        : null,
      bill.totals.totalInsurancePaid != null
        ? `${usd(bill.totals.totalInsurancePaid)} payment`
        : null,
    ].filter(Boolean) as string[];
    const leftOver = Math.round((headerPatientResp - unallocated) * 100) / 100;

    return [
      buildFinding({
        unallocated,
        totalBilled,
        title: `Unallocated balance: ${usd(unallocated)}`,
        description:
          `This bill's own numbers don't add up. It charges you ${usd(headerPatientResp)}, ` +
          `but the total charge of ${usd(totalBilled)} less ${reductions.join(" and ")} ` +
          `leaves ${usd(leftOver)}. The remaining ${usd(unallocated)} is unaccounted for. ` +
          `Ask the provider to explain the difference before paying.`,
        benchmarkSource: IDENTITY_BENCHMARK_SOURCE,
        // The same components the sentence above is built from, carried
        // structurally so the dispute letter states the gap in provider voice
        // without a second subtraction anywhere.
        arithmeticGap: {
          billed: totalBilled,
          reductions,
          leftOver,
          billedToPatient: headerPatientResp,
          unaccounted: unallocated,
        },
      }),
    ];
  }

  // ── Path 1 (S74.5 D15) — the lines don't itemise everything owed ──────────
  const sumLinePatientResp = bill.lineItems.reduce(
    (acc, li) => acc + (li.patientResponsibility ?? 0),
    0,
  );

  const unallocated = headerPatientResp - sumLinePatientResp;
  if (unallocated <= 0) return [];

  const thresholdCents = await readThresholdCents();
  const unallocatedCents = Math.round(unallocated * 100);
  if (unallocatedCents < thresholdCents) return [];

  return [
    buildFinding({
      unallocated,
      totalBilled,
      title: `Unallocated balance: $${unallocated.toFixed(2)}`,
      description: `Provider's bill shows you owe $${headerPatientResp.toFixed(
        2,
      )} but only $${sumLinePatientResp.toFixed(
        2,
      )} is itemized across the listed line items. The remaining $${unallocated.toFixed(
        2,
      )} is unaccounted for. Request an itemized statement before paying — providers are required to provide one on request.`,
      benchmarkSource: "claim_header_arithmetic",
    }),
  ];
}
