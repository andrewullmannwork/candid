/**
 * Plan-vs-ACA override message helper. Originally inline in ClaimDetail.tsx
 * (S135); relocated S139 (B4.2 multi-line) so LineDrawer plan card can render
 * the same sub-line without importing from a component module.
 *
 * ACA-compliant plans must cover preventive / vaccine services at $0 patient
 * cost-share in-network regardless of stated plan terms. When plan terms
 * disagree (e.g., plan says $25 copay for an annual checkup), this helper
 * produces the inline disclosure copy that surfaces both layers of truth.
 */

import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";

export interface AcaOverride {
  planCopay: number | null;
  planCoinsurance: number | null;
  planCovered: boolean | null;
  basis: string | null;
}

export function buildAcaOverrideLine(
  acaOverride: AcaOverride | null | undefined,
): string | null {
  if (!acaOverride) return null;
  if (acaOverride.planCovered === false) {
    return "Plan lists as not covered, but federal law (ACA) requires $0 for this preventive service.";
  }
  const parts: string[] = [];
  if (acaOverride.planCopay != null && acaOverride.planCopay > 0) {
    parts.push(`$${acaOverride.planCopay} copay`);
  }
  if (
    acaOverride.planCoinsurance != null &&
    acaOverride.planCoinsurance > 0
  ) {
    parts.push(
      `${normalizeCoinsurancePct(acaOverride.planCoinsurance)}% coinsurance`,
    );
  }
  const planTerms = parts.length > 0 ? parts.join(" + ") : "non-$0 cost share";
  return `Plan says ${planTerms}, but federal law (ACA) requires $0 for this preventive service.`;
}
