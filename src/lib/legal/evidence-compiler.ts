/**
 * Evidence Package Compiler — assembles all Candid data into a court-ready document.
 *
 * 9 sections, each with appropriate disclaimers:
 * 1. Claim Summary
 * 2. Audit Analysis
 * 3. Plan Coverage Evidence
 * 4. Discrepancy Documentation
 * 5. Network Evidence
 * 6. Pricing Comparison
 * 7. Dispute History
 * 8. Timeline
 * 9. Per-section disclaimers + master disclaimer
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { DISCLAIMERS } from "./disclaimers";

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
}

/**
 * Compile a complete evidence package for a claim.
 */
export async function compileEvidencePackage(
  supabase: SupabaseClient,
  params: {
    claimId: string;
    userId: string;
    disputeId?: string;
  }
): Promise<EvidencePackage> {
  const { claimId, userId, disputeId } = params;
  const sections: EvidenceSection[] = [];

  // 1. Claim Summary
  const { data: claim } = await supabase
    .from("claims")
    .select("*, claim_line_items(*)")
    .eq("id", claimId)
    .eq("user_id", userId)
    .single();

  if (claim) {
    const lineItems = (claim.claim_line_items || []) as Array<Record<string, unknown>>;
    const lineDetails = lineItems.map((li, i) =>
      `  ${i + 1}. ${li.description || "Unknown"} — Code: ${li.billing_code || "N/A"} — Billed: $${li.billed_amount || 0} — Patient: $${li.patient_owes || 0}`
    ).join("\n");

    sections.push({
      title: "1. Claim Summary",
      content: `Date of Service: ${claim.date_of_service || "Unknown"}
Provider: ${(claim.metadata as Record<string, unknown>)?.provider ? ((claim.metadata as Record<string, unknown>).provider as Record<string, unknown>)?.name : "Unknown"}
Total Billed: $${claim.total_billed || 0}
Insurance Paid: $${claim.total_insurance_paid || 0}
Patient Responsibility: $${claim.total_patient_responsibility || 0}

Line Items:
${lineDetails}`,
      disclaimer: DISCLAIMERS.coverage_check,
    });
  }

  // 2. Audit Analysis
  if (claim) {
    const lineItems = (claim.claim_line_items || []) as Array<Record<string, unknown>>;
    const findings: Array<Record<string, unknown>> = [];
    for (const li of lineItems) {
      const auditFindings = (li.metadata as Record<string, unknown>)?.auditFindings;
      if (Array.isArray(auditFindings)) findings.push(...auditFindings);
    }

    if (findings.length > 0) {
      sections.push({
        title: "2. Audit Analysis",
        content: `${findings.length} billing issue(s) identified:\n\n` +
          findings.map((f, i) =>
            `  ${i + 1}. ${f.title} (${f.type}, ${f.severity})\n     Estimated overcharge: $${f.estimatedOvercharge || 0}\n     ${f.description || ""}`
          ).join("\n\n"),
        disclaimer: DISCLAIMERS.discrepancy_alert,
      });
    }
  }

  // 3. Plan Coverage Evidence
  if (claim?.insurance_plan_id) {
    const { data: coverage } = await supabase
      .from("plan_covered_services")
      .select("covered, in_copay, in_coinsurance, source, confidence, service_catalog!inner(slug, name)")
      .eq("insurance_plan_id", claim.insurance_plan_id);

    if (coverage && coverage.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const relevant = coverage.filter((c) => {
        const lineItems = (claim.claim_line_items || []) as Array<Record<string, unknown>>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return lineItems.some((li) => li.service_slug === (c.service_catalog as any)?.slug);
      });

      if (relevant.length > 0) {
        sections.push({
          title: "3. Plan Coverage Evidence",
          content: "Services from this claim and their plan coverage terms:\n\n" +
            relevant.map((c) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const name = (c.service_catalog as any)?.name || (c.service_catalog as any)?.slug;
              const parts = [`  - ${name}`];
              if (c.in_copay != null) parts.push(`Copay: $${c.in_copay}`);
              if (c.in_coinsurance != null) parts.push(`Coinsurance: ${(c.in_coinsurance * 100).toFixed(0)}%`);
              parts.push(`Source: ${c.source} (${Math.round((c.confidence || 0) * 100)}% confidence)`);
              return parts.join(" | ");
            }).join("\n"),
          disclaimer: DISCLAIMERS.coverage_check,
        });
      }
    }
  }

  // 4. Discrepancy Documentation
  const { data: discrepancies } = await supabase
    .from("claim_discrepancies")
    .select("*")
    .eq("claim_id", claimId)
    .in("status", ["flagged", "verifying", "disputed"]);

  if (discrepancies && discrepancies.length > 0) {
    sections.push({
      title: "4. Discrepancy Documentation",
      content: `${discrepancies.length} discrepancy(ies) detected:\n\n` +
        discrepancies.map((d, i) =>
          `  ${i + 1}. ${d.field} (Tier ${d.tier})${d.is_systemic ? " [SYSTEMIC PATTERN]" : ""}
     Expected: ${d.expected_value}
     Actual: ${d.actual_value}
     Source: ${d.expected_source} (${Math.round(d.expected_confidence * 100)}% confidence)`
        ).join("\n\n"),
      disclaimer: DISCLAIMERS.discrepancy_alert,
    });
  }

  // 5. Network Evidence
  const systemicDiscs = discrepancies?.filter((d) => d.is_systemic) || [];
  if (systemicDiscs.length > 0) {
    sections.push({
      title: "5. Network / Systemic Evidence",
      content: `Systemic insurer patterns detected affecting multiple plan members:\n\n` +
        systemicDiscs.map((d) =>
          `  - ${d.service_slug.replace(/_/g, " ")}: ${d.systemic_user_count || "Multiple"} members affected
     Expected: ${d.expected_value} | Actual: ${d.actual_value}`
        ).join("\n"),
      disclaimer: DISCLAIMERS.network_evidence,
    });
  }

  // 6. Pricing Comparison (if Care data available)
  // Best-effort — may not have data
  sections.push({
    title: "6. Pricing Comparison",
    content: "Community pricing data and Medicare benchmarks for services in this claim are available through Candid Care. Log in to view current data.",
    disclaimer: DISCLAIMERS.pricing_care,
  });

  // 7. Dispute History
  if (disputeId) {
    const { data: dispute } = await supabase
      .from("dispute_outcomes")
      .select("*")
      .eq("id", disputeId)
      .single();

    if (dispute) {
      sections.push({
        title: "7. Dispute History",
        content: `Dispute Type: ${dispute.dispute_type}
Status: ${dispute.status}
Filed: ${dispute.filed_date}
Amount Disputed: $${dispute.amount_disputed || 0}
Amount Recovered: $${dispute.amount_recovered || 0}
${dispute.resolution_date ? `Resolved: ${dispute.resolution_date}` : "Pending resolution"}`,
        disclaimer: DISCLAIMERS.accuracy_rate,
      });
    }
  }

  // 8. Timeline
  const events: Array<{ date: string; event: string }> = [];
  if (claim?.date_of_service) events.push({ date: claim.date_of_service, event: "Date of service" });
  if (claim?.created_at) events.push({ date: claim.created_at.split("T")[0], event: "Bill uploaded to Candid" });
  if (discrepancies?.length) events.push({ date: discrepancies[0].created_at.split("T")[0], event: "Discrepancies detected" });

  if (events.length > 0) {
    sections.push({
      title: "8. Timeline of Events",
      content: events
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((e) => `  ${e.date} — ${e.event}`)
        .join("\n"),
      disclaimer: "",
    });
  }

  return {
    title: `Evidence Package — Claim ${claimId.slice(0, 8)}`,
    generatedAt: new Date().toISOString(),
    masterDisclaimer: DISCLAIMERS.small_claims,
    sections,
  };
}

/**
 * Format the evidence package as a plain text document.
 */
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
