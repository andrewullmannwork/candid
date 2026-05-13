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

export async function runClaimHeaderArithmeticCheck(
  bill: ParsedBill,
): Promise<AuditFinding[]> {
  const flagOn = await isFeatureEnabled("s74_5_categorization_flywheel_v1");
  if (!flagOn) return [];

  const headerPatientResp = bill.totals.totalPatientResponsibility;
  if (headerPatientResp == null || headerPatientResp <= 0) return [];

  // Parser confidence proxy: at least one line must have patientResponsibility
  // set. If ALL lines are missing it, parser likely couldn't extract; skip
  // (avoid false positive "everything unallocated").
  const linesWithPatientResp = bill.lineItems.filter(
    (li) => li.patientResponsibility != null,
  );
  if (linesWithPatientResp.length === 0) return [];

  // Additional proxy: if header totalBilled is missing entirely we have low
  // confidence on the header totals at all — skip.
  if (bill.totals.totalBilled == null || bill.totals.totalBilled <= 0) return [];

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
    {
      id: randomUUID(),
      type: "unallocated_balance",
      severity:
        unallocated >= 250 ? "high" : unallocated >= 50 ? "medium" : "low",
      lineItems: [], // claim-header finding spans the bill, not specific lines
      title: `Unallocated balance: $${unallocated.toFixed(2)}`,
      description: `Provider's bill shows you owe $${headerPatientResp.toFixed(
        2,
      )} but only $${sumLinePatientResp.toFixed(
        2,
      )} is itemized across the listed line items. The remaining $${unallocated.toFixed(
        2,
      )} is unaccounted for. Request an itemized statement before paying — providers are required to provide one on request.`,
      estimatedOvercharge: unallocated,
      benchmarkSource: "claim_header_arithmetic",
      billedAmount: bill.totals.totalBilled ?? 0,
      confidence: 0.75,
      actionable: true,
    },
  ];
}
