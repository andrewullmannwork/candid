// S74.5 D13 — Zero-cost-share registry audit stage.
//
// Per plans/s74.5_categorization_flywheel.md v2 §7.1 + Q-A/B/C/K LOCK.
//
// Runs BEFORE the plan-coverage check. For each line item, looks up
// zero_cost_share_codes (ACA preventive + ACIP vaccine) by (billing_code,
// billing_code_type). On hit + patient_responsibility > 0 → flag overcharge
// finding type "zero_cost_share_overcharge" with source_url for dispute
// evidence citation.
//
// Demographic-based eligibility filtering (age/sex windows) is deferred to v2:
// user profile data needs to be threaded through audit pipeline. For v1, the
// row's source_label + age_min/age_max are surfaced in the finding description
// so user can self-dismiss if not applicable.

import { createServerClient } from "../supabase/server";
import { isFeatureEnabled } from "../config/product-flags";
import type { ParsedBill, AuditFinding, BillLineItem } from "../billing/types";
import { inferProcedureCodeType } from "../billing/code-type-inference";
import { randomUUID } from "crypto";

interface ZeroCostShareRow {
  id: string;
  billing_code: string;
  billing_code_type: string;
  coverage_basis: "ACA_preventive" | "ACIP_vaccine";
  category: string | null;
  uspstf_grade: "A" | "B" | null;
  age_min: number | null;
  age_max: number | null;
  sex: "M" | "F" | null;
  frequency_limit: string | null;
  source_url: string;
  source_label: string;
  display_name: string;
}

export async function runZeroCostShareCheck(
  bill: ParsedBill,
): Promise<AuditFinding[]> {
  const flagOn = await isFeatureEnabled("s74_5_categorization_flywheel_v1");
  if (!flagOn) return [];

  const eligibleLines = bill.lineItems.filter(
    (li) => li.procedureCode && (li.patientResponsibility ?? 0) > 0.5,
  );
  if (eligibleLines.length === 0) return [];

  const supabase = createServerClient();
  const findings: AuditFinding[] = [];

  // Build lookup keys per line — pair (code, codeType) where codeType uses our
  // ProcedureCodeType namespace (inferred via D0 helper if upstream omitted).
  const lookupKeys = eligibleLines.map((li) => {
    const code = li.procedureCode;
    const codeType = li.procedureCodeType ?? inferProcedureCodeType(code);
    return { lineNumber: li.lineNumber, code, codeType, item: li };
  });

  const codeTypeNamespaceWhitelist = new Set([
    "CPT",
    "HCPCS_L2",
    "G_CODE",
    "CAT_II",
  ]);

  const distinctCodes = Array.from(
    new Set(
      lookupKeys
        .filter((k) => k.codeType && codeTypeNamespaceWhitelist.has(k.codeType))
        .map((k) => `${k.code}|${k.codeType}`),
    ),
  );
  if (distinctCodes.length === 0) return [];

  // Single OR-style query — Supabase doesn't natively support tuple IN,
  // so we issue one query per (code, codeType) using .in on code with
  // post-filter on codeType. Small volume per bill (<10 codes); acceptable.
  // Order by coverage_basis ascending so when a code appears under both
  // ACA_preventive + ACIP_vaccine, the ACA row sorts first deterministically
  // (matchingRows[0] below). Stable for snapshot tests + dispute citations.
  const { data: rows, error } = await supabase
    .from("zero_cost_share_codes")
    .select(
      "id, billing_code, billing_code_type, coverage_basis, category, uspstf_grade, age_min, age_max, sex, frequency_limit, source_url, source_label, display_name",
    )
    .in(
      "billing_code",
      lookupKeys.map((k) => k.code),
    )
    .is("retired_at", null)
    .order("coverage_basis", { ascending: true });

  if (error) {
    console.warn("[zero-cost-share] lookup failed", error);
    return [];
  }
  if (!rows || rows.length === 0) return [];

  const rowsTyped = rows as ZeroCostShareRow[];

  for (const k of lookupKeys) {
    if (!k.codeType) continue;
    const matchingRows = rowsTyped.filter(
      (r) =>
        r.billing_code === k.code &&
        r.billing_code_type === k.codeType,
    );
    if (matchingRows.length === 0) continue;

    // Prefer the most specific row (oldest first, ACA preventive before ACIP if both match)
    const row = matchingRows[0];
    findings.push(buildFinding(k.item, row));
  }

  return findings;
}

function buildFinding(item: BillLineItem, row: ZeroCostShareRow): AuditFinding {
  const charged = item.patientResponsibility ?? 0;
  const basisLabel =
    row.coverage_basis === "ACA_preventive"
      ? "ACA-mandated preventive service"
      : "ACIP-recommended vaccine";

  const eligibilityNote = formatEligibilityNote(row);

  return {
    id: randomUUID(),
    type: "zero_cost_share_overcharge",
    severity: charged >= 100 ? "high" : charged >= 25 ? "medium" : "low",
    lineItems: [item.lineNumber],
    title: `Likely $0 service — ${row.display_name}`,
    description: `You were charged $${charged.toFixed(
      2,
    )} for this service. Under federal law (${basisLabel}), ACA-compliant plans must cover this at $0 patient cost-share when delivered in-network.${
      eligibilityNote ? " " + eligibilityNote : ""
    } Source: ${row.source_label}.`,
    estimatedOvercharge: charged,
    benchmarkSource: row.source_url,
    benchmarkAmount: 0,
    billedAmount: item.billedAmount,
    confidence: 0.85,
    actionable: true,
  };
}

function formatEligibilityNote(row: ZeroCostShareRow): string {
  const parts: string[] = [];
  if (row.age_min != null && row.age_max != null) {
    parts.push(`Age ${row.age_min}-${row.age_max}`);
  } else if (row.age_min != null) {
    parts.push(`Age ${row.age_min}+`);
  } else if (row.age_max != null) {
    parts.push(`Age 0-${row.age_max}`);
  }
  if (row.sex) {
    parts.push(row.sex === "F" ? "biological females" : "biological males");
  }
  if (row.frequency_limit) {
    parts.push(`limit: ${row.frequency_limit}`);
  }
  if (parts.length === 0) return "";
  return `Eligibility: ${parts.join("; ")}.`;
}
