// Audit engine — orchestrates bill parsing, benchmark lookup, and rule evaluation

import type { AuditReport, ParsedBill, AuditFinding } from "../billing/types";
import { lookupCMSRatesBatch } from "../cms/ppl";
import { ALL_RULES } from "./rules";
import { runZeroCostShareCheck } from "./zero-cost-share";
import { runClaimHeaderArithmeticCheck } from "./claim-header-arithmetic";
import { randomUUID } from "crypto";

export async function runAudit(bill: ParsedBill): Promise<AuditReport> {
  // Step 1: Look up CMS benchmarks for all procedure codes in the bill
  const codes = bill.lineItems.map((item) => ({
    code: item.procedureCode,
    modifier: item.modifier,
  }));

  const benchmarks = await lookupCMSRatesBatch(codes);

  // Step 2: Run all audit rules
  const allFindings: AuditFinding[] = [];

  for (const rule of ALL_RULES) {
    const findings = rule(bill, benchmarks);
    allFindings.push(...findings);
  }

  // Step 2b: S74.5 D13 — Zero-cost-share registry check (ACA preventive + ACIP
  // vaccine). Runs BEFORE plan-coverage check semantically; fires only when
  // s74_5_categorization_flywheel_v1 flag is ON.
  const zeroCostFindings = await runZeroCostShareCheck(bill);
  allFindings.push(...zeroCostFindings);

  // Step 2c: S74.5 D15 — Claim-header arithmetic check. Catches unallocated
  // balance between header total and itemized lines. Gated on same flag.
  const headerFindings = await runClaimHeaderArithmeticCheck(bill);
  allFindings.push(...headerFindings);

  // Step 3: Deduplicate findings that flag the same line items
  const deduped = deduplicateFindings(allFindings);

  // Step 4: Sort by severity (critical first) then by estimated overcharge
  deduped.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return b.estimatedOvercharge - a.estimatedOvercharge;
  });

  // Step 5: Build report
  return {
    id: randomUUID(),
    documentId: bill.documentId,
    userId: bill.userId,
    parsedBill: bill,
    findings: deduped,
    summary: {
      totalFindings: deduped.length,
      totalEstimatedOvercharge: deduped.reduce(
        (sum, f) => sum + f.estimatedOvercharge,
        0
      ),
      highSeverityCount: deduped.filter(
        (f) => f.severity === "high" || f.severity === "critical"
      ).length,
      actionableCount: deduped.filter((f) => f.actionable).length,
    },
    createdAt: new Date().toISOString(),
  };
}

function deduplicateFindings(findings: AuditFinding[]): AuditFinding[] {
  const seen = new Map<string, AuditFinding>();

  for (const finding of findings) {
    // Key on type + sorted line items
    const key = `${finding.type}-${finding.lineItems.sort().join(",")}`;

    if (!seen.has(key)) {
      seen.set(key, finding);
    } else {
      // Keep the one with higher estimated overcharge
      const existing = seen.get(key)!;
      if (finding.estimatedOvercharge > existing.estimatedOvercharge) {
        seen.set(key, finding);
      }
    }
  }

  return Array.from(seen.values());
}
