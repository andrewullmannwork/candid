/**
 * Evidence Package Compiler — assembles all Candid data into a court-ready document.
 *
 * Reworked for t_dispute_letter_redesign Phase 5 to share the
 * evidence-resolver with the dispute-letter pipeline:
 *   - Section 0 is the full dispute letter verbatim (when provided)
 *   - Every other section pulls from a single DisputeEvidence object so
 *     the letter and Case File can never drift.
 *   - Plan Coverage Evidence includes the same citations (+ direct SBC
 *     quotes when available from Phase 4.5).
 *
 * Back-compat: the existing legacy callers pass only `{ claimId, userId }`;
 * they still work. New callers pass `{ claimId, userId, disputeId,
 * letterContent, planContext, evidence }` for the richer package.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { DISCLAIMERS } from "./disclaimers";
import type { PlanContext } from "@/lib/disputes/plan-context";
import type { DisputeEvidence, LineItemEvidence } from "@/lib/disputes/evidence-resolver";
import { resolvePlanContext } from "@/lib/disputes/plan-context";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";

export interface EvidenceSection {
  title: string;
  content: string;
  disclaimer: string;
}

export interface EvidencePackage {
  title: string;
  generatedAt: string;
  masterDisclaimer: string;
  sections: EvidenceSection[];
  // Extended fields for the redesigned Case File. Older consumers (plain-text
  // formatter) ignore these; the PDF renderer + admin UI use them.
  planContext?: PlanContext | null;
  evidence?: DisputeEvidence | null;
  letterContent?: string | null;
}

interface CompileParams {
  claimId: string;
  userId: string;
  disputeId?: string;
  /** Full dispute letter body to embed as Section 0. */
  letterContent?: string | null;
  /** Pre-resolved plan context; resolver falls back when omitted. */
  planContext?: PlanContext | null;
  /** Pre-resolved DisputeEvidence; resolver falls back when omitted. */
  evidence?: DisputeEvidence | null;
}

export async function compileEvidencePackage(
  supabase: SupabaseClient,
  params: CompileParams,
): Promise<EvidencePackage> {
  const { claimId, userId, disputeId, letterContent } = params;
  const sections: EvidenceSection[] = [];

  // Resolve plan context + evidence once, share across sections.
  const planContext = params.planContext ?? (await resolvePlanContext(supabase, {
    userId,
    claimId,
  }));
  const evidence = params.evidence ?? (await resolveEvidence(supabase, {
    userId,
    claimIds: [claimId],
    planContext,
    letterType: "insurance_appeal",
  }));

  const claim = evidence.claims[0] ?? null;

  // ── Section 0 — Full Dispute Letter (new in Phase 5) ──────────────────────
  if (letterContent) {
    sections.push({
      title: "0. Dispute Letter (full text)",
      content:
        letterContent.trim() +
        "\n\n— This letter is the user's draft; it has not been submitted to the insurer as of this Case File generation.",
      disclaimer: "",
    });
  }

  // ── Section 1 — Claim Summary (from resolver) ─────────────────────────────
  if (claim) {
    const lineDetails = claim.lineItemEvidence
      .map((li, i) =>
        `  ${i + 1}. ${li.serviceName} — Code: ${li.billingCode ? `${li.billingCode.type} ${li.billingCode.value}` : "N/A"} — Billed: ${formatUsd(li.billedAmount)} — Insurance paid: ${formatUsd(li.insurancePaid ?? 0)} — Patient: ${formatUsd(li.patientOwes ?? 0)}${li.discrepancyAmount && li.discrepancyAmount > 0 ? ` — Discrepancy: ${formatUsd(li.discrepancyAmount)}` : ""}`,
      )
      .join("\n");

    sections.push({
      title: "1. Claim Summary",
      content: `Date of Service: ${claim.dateOfService ?? "Unknown"}
Provider: ${claim.providerName ?? "Unknown"}
Plan Year: ${claim.planYear ?? "Unknown"}
Total Billed: ${formatUsd(claim.totalBilled)}
Line Item Count: ${claim.lineItemEvidence.length}

Line Items:
${lineDetails}`,
      disclaimer: DISCLAIMERS.coverage_check,
    });
  }

  // ── Section 2 — Audit Analysis (from claim_line_items.metadata) ──────────
  if (claim) {
    const { data: lineItems } = await supabase
      .from("claim_line_items")
      .select("metadata")
      .eq("claim_id", claimId);
    const findings: Array<Record<string, unknown>> = [];
    for (const li of lineItems ?? []) {
      const auditFindings = (li.metadata as Record<string, unknown>)?.auditFindings;
      if (Array.isArray(auditFindings)) findings.push(...(auditFindings as Record<string, unknown>[]));
    }
    if (findings.length > 0) {
      sections.push({
        title: "2. Audit Analysis",
        content: `${findings.length} billing issue(s) identified:\n\n` +
          findings.map((f, i) =>
            `  ${i + 1}. ${f.title} (${f.type}, ${f.severity})\n     Estimated overcharge: ${formatUsd(Number(f.estimatedOvercharge) || 0)}\n     ${f.description || ""}`
          ).join("\n\n"),
        disclaimer: DISCLAIMERS.discrepancy_alert,
      });
    }
  }

  // ── Section 3 — Plan Coverage Evidence (expanded with SBC quotes) ────────
  if (claim) {
    const bullets = claim.lineItemEvidence
      .filter((li) => li.planBenefit)
      .map((li) => renderCoverageBullet(li))
      .join("\n\n");

    if (bullets) {
      sections.push({
        title: "3. Plan Coverage Evidence",
        content: `Plan: ${planContext?.plan?.planName ?? "—"}${planContext?.plan?.planYear ? ` (${planContext.plan.planYear})` : ""}
Insurer: ${planContext?.insurer?.name ?? planContext?.plan?.insurerName ?? "—"}

Per-service coverage terms drawn from the plan SBC:

${bullets}`,
        disclaimer: DISCLAIMERS.coverage_check,
      });
    }
  }

  // ── Section 4 — Discrepancy Documentation (from resolver) ────────────────
  if (claim) {
    const discBullets = claim.lineItemEvidence
      .filter((li) => li.discrepancyAmount != null && li.discrepancyAmount > 0)
      .map((li, i) =>
        `  ${i + 1}. ${li.serviceName}${li.billingCode ? ` (${li.billingCode.type} ${li.billingCode.value})` : ""}
     Expected patient cost: ${formatUsd(li.expectedPatientCost ?? 0)}
     Actual patient cost:   ${formatUsd(li.actualPatientCost ?? 0)}
     Discrepancy:           ${formatUsd(li.discrepancyAmount ?? 0)}
     Reason: ${li.discrepancyReason ?? "—"}`,
      )
      .join("\n\n");

    if (discBullets) {
      sections.push({
        title: "4. Discrepancy Documentation",
        content: discBullets,
        disclaimer: DISCLAIMERS.discrepancy_alert,
      });
    }
  }

  // ── Section 5 — Network Evidence (systemic + directory) ──────────────────
  const { data: systemicDiscs } = await supabase
    .from("claim_discrepancies")
    .select("service_slug, expected_value, actual_value, systemic_user_count")
    .eq("claim_id", claimId)
    .eq("is_systemic", true);
  if (systemicDiscs && systemicDiscs.length > 0) {
    sections.push({
      title: "5. Network / Systemic Evidence",
      content: `Systemic insurer patterns detected affecting multiple plan members:\n\n` +
        systemicDiscs.map((d) =>
          `  - ${String(d.service_slug ?? "").replace(/_/g, " ")}: ${d.systemic_user_count ?? "Multiple"} members affected
     Expected: ${d.expected_value} | Actual: ${d.actual_value}`
        ).join("\n"),
      disclaimer: DISCLAIMERS.network_evidence,
    });
  }

  // ── Section 6 — Pricing Comparison (real numbers when k-anon met) ────────
  if (evidence.communityEvidence) {
    const b = evidence.communityEvidence;
    sections.push({
      title: "6. Pricing Comparison",
      content: `Community data (${b.sameCodeSamePlanCount} reports${b.sameCodeSamePlanCount < 5 ? " — below k-anonymity threshold; aggregate suppressed" : ""}):
- Median copay paid: ${b.medianCopayPaid != null ? formatUsd(b.medianCopayPaid) : "—"}
- Medicare rate: ${b.pricingBenchmarks.medicareRate != null ? formatUsd(b.pricingBenchmarks.medicareRate) : "—"}
- Community median: ${b.pricingBenchmarks.communityMedian != null ? formatUsd(b.pricingBenchmarks.communityMedian) : "—"}`,
      disclaimer: DISCLAIMERS.pricing_care,
    });
  } else {
    sections.push({
      title: "6. Pricing Comparison",
      content:
        "Community pricing data for the services in this claim is not yet available at the k-anonymity threshold (< 5 independent reports). Candid Care will populate this section once more community data accumulates.",
      disclaimer: DISCLAIMERS.pricing_care,
    });
  }

  // ── Section 7 — Dispute Timeline ─────────────────────────────────────────
  const events: Array<{ date: string; event: string }> = [];
  if (claim?.dateOfService) events.push({ date: claim.dateOfService, event: "Date of service" });
  if (disputeId) {
    const { data: dispute } = await supabase
      .from("dispute_outcomes")
      .select("filed_date, status, resolution_date, amount_recovered")
      .eq("id", disputeId)
      .maybeSingle();
    if (dispute?.filed_date) {
      events.push({ date: dispute.filed_date, event: `Dispute drafted — status: ${dispute.status}` });
    }
    if (dispute?.resolution_date) {
      events.push({
        date: dispute.resolution_date,
        event: `Dispute resolved — recovered ${formatUsd(Number(dispute.amount_recovered ?? 0))}`,
      });
    }
  }
  if (events.length > 0) {
    sections.push({
      title: "7. Dispute Timeline",
      content: events.sort((a, b) => a.date.localeCompare(b.date)).map((e) => `  ${e.date} — ${e.event}`).join("\n"),
      disclaimer: "",
    });
  }

  // ── Section 8 — Legal Framework ─────────────────────────────────────────
  if (evidence.legalBasis.length > 0) {
    sections.push({
      title: "8. Legal Framework",
      content: evidence.legalBasis
        .map((l) => `  - ${l.statute}: ${l.summary}${l.appliesTo.length ? ` (supports: ${l.appliesTo.join(", ")})` : ""}`)
        .join("\n"),
      disclaimer: "",
    });
  }

  // ── Section 9 — Disclaimers (unchanged) ─────────────────────────────────

  return {
    title: `Evidence Package — Claim ${claimId.slice(0, 8)}`,
    generatedAt: new Date().toISOString(),
    masterDisclaimer: DISCLAIMERS.small_claims,
    sections,
    planContext,
    evidence,
    letterContent: letterContent ?? null,
  };
}

function renderCoverageBullet(li: LineItemEvidence): string {
  const b = li.planBenefit;
  if (!b) return "";
  const parts: string[] = [];
  parts.push(`  • ${li.serviceName}${li.billingCode ? ` (${li.billingCode.type} ${li.billingCode.value})` : ""}`);
  if (b.copay != null) parts.push(`      Copay: ${formatUsd(b.copay)}`);
  if (b.coinsurance != null) parts.push(`      Coinsurance: ${Math.round(b.coinsurance * 100)}%`);
  parts.push(`      Citation: ${b.citation}`);
  if (b.sbcExcerpt) parts.push(`      SBC quote: "${b.sbcExcerpt.trim()}"`);
  return parts.join("\n");
}

function formatUsd(n: number): string {
  const v = Math.round(n * 100) / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatEvidencePackageAsText(pkg: EvidencePackage): string {
  const divider = "═".repeat(60);
  const thinDivider = "─".repeat(60);

  let text = `${divider}
${pkg.title}
Generated: ${new Date(pkg.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
${divider}

IMPORTANT DISCLAIMER:
${pkg.masterDisclaimer}

${divider}

`;

  for (const section of pkg.sections) {
    text += `${section.title}\n${thinDivider}\n\n${section.content}\n`;
    if (section.disclaimer) {
      text += `\n[Note: ${section.disclaimer}]\n`;
    }
    text += `\n`;
  }

  text += `${divider}\nEnd of Evidence Package\n${divider}\n`;
  return text;
}
