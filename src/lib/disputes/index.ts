// Dispute letter generator — creates letters from audit findings

import type {
  AuditReport,
  AuditFinding,
  DisputeLetter,
  DisputeLetterType,
  FindingType,
} from "../billing/types";
import { LETTER_TEMPLATES } from "./templates";
import type { PlanBenefitEvidence } from "./templates";
import type { PlanContext } from "./plan-context";
import type { DisputeEvidence } from "./evidence-resolver";
import { resolveLetterRecovery } from "./dispute-grounds";
import { deriveFindingToLetter } from "./dispute-ground-catalog";
import type { CostShareV2Result } from "../claims/recovery-math";
import { randomUUID } from "crypto";

export type { PlanBenefitEvidence };

// Map finding types to appropriate letter types — PROJECTED from DISPUTE_GROUND_CATALOG (the
// single source of truth). Byte-identical to the prior hardcoded map at the consumer below
// (`FINDING_TO_LETTER[findings[0].type] || "overcharge"`): findings raised by no ground
// (upcoding/stale_claim/uncategorized) are absent here and fall to that default. Pinned by the
// catalog-projection-parity fixture across all FindingType.
const FINDING_TO_LETTER: Partial<Record<FindingType, DisputeLetterType>> = deriveFindingToLetter();

/**
 * Who the finished letter is addressed to — the single source of truth shared by
 * the templates (which recipient block + request verbs to emit) and the
 * readiness floor (which mailing address MVDL #3 requires). Only the
 * insurance-appeal letter is addressed to the INSURER (templates.ts
 * `insuranceAppealTemplate` is the sole `buildInsurerRecipientBlock` call site);
 * every other letter type goes to the PROVIDER.
 *
 * Accepts either the resolved `DisputeLetterType` ("insurance_appeal") OR a raw
 * `dispute_outcomes.dispute_type` ("internal_appeal", "cost_share_misapplication",
 * "coverage_contradiction", "not_covered") so callers can pass whichever they
 * have without a second resolve. Unknown / undefined → "provider" (the common
 * case + the conservative default: requires the address the provider letter prints).
 */
// EXHAUSTIVE over DisputeLetterType — the compiler forces every letter type to declare its
// recipient here, so a new type cannot silently fall through to "provider" (dispute-letters v2
// S2 hardening; replaces the prior silent-omit Set).
export type LetterRecipientKind = "insurer" | "provider" | "collector";

const RECIPIENT_BY_LETTER_TYPE: Record<DisputeLetterType, LetterRecipientKind> = {
  overcharge: "provider",
  duplicate_charge: "provider",
  balance_billing: "provider",
  itemized_request: "provider",
  negotiation: "provider",
  insurance_appeal: "insurer",
  final_notice: "provider",
  external_review: "insurer",
  debt_validation: "collector",
};

// Raw dispute_outcomes.dispute_type values (NOT DisputeLetterType) that resolve to the insurer —
// the legacy rerender path passes these directly.
const INSURER_DISPUTE_TYPES = new Set<string>([
  "internal_appeal",
  "cost_share_misapplication",
  "coverage_contradiction",
  "not_covered",
]);

export function letterRecipientKind(
  type: string | null | undefined,
): LetterRecipientKind {
  if (!type) return "provider";
  if (Object.prototype.hasOwnProperty.call(RECIPIENT_BY_LETTER_TYPE, type)) {
    return RECIPIENT_BY_LETTER_TYPE[type as DisputeLetterType];
  }
  return INSURER_DISPUTE_TYPES.has(type) ? "insurer" : "provider";
}

export interface GenerateDisputeLetterOptions {
  planEvidence?: PlanBenefitEvidence[];
  planContext?: PlanContext | null;
  evidence?: DisputeEvidence | null;
  /**
   * Phase 4 Task 4-E. When true, dispute letter blockquote rendering is gated by
   * Pattern P-8 cite-grade verification per Q-P4-2 LOCK (legal surface). Caller
   * supplies this from `consumer_read_filter_v1` flag state. Defaults false
   * (legacy / flag OFF behavior — all blockquotes render unconditionally).
   */
  gateUnverified?: boolean;
  /**
   * Block A — data-trust HARD STOP enforcement. When true AND the resolved
   * evidence carries a header-reconciliation failure, generation is suppressed
   * (returns null). The caller passes the `dispute_letter_v3_design` flag state;
   * default false preserves today's behavior (letters generate regardless of
   * reconciliation state). Defense-in-depth — the generate route also gates,
   * but enforcing here means no caller can route around it (legal L3: the gate
   * is a shield). See plans/dispute_letter_overhaul.md §1a.
   */
  enforceDataTrustGate?: boolean;
  /**
   * §18 incr-3 (dispute_grounds_v1) — when true, the 3 provider templates source
   * their finding block from the resolved EVIDENCE (rerender-safe) instead of the
   * AuditReport `findings`, killing the $0.00 refresh bug. Caller passes the
   * dispute_grounds_v1 flag state. Default false → byte-identical. A SEPARATE flag
   * from enforceDataTrustGate/v3DesignOn (not folded into that overload).
   */
  disputeGroundsOn?: boolean;
  /**
   * §18 incr-4 — the rich per-line cost-share basis (loadDisputeGroundBasis's
   * Map<lineItemId, CostShareV2Result>), loaded by the route when dispute_grounds_v1 is
   * ON. Resolved here into the per-line deductible-aware letter dollars (resolveLetterRecovery)
   * and threaded to the templates. Absent → byte-identical (the request block falls back to
   * the deductible-blind discrepancyAmount).
   */
  disputeGroundBasis?: Map<string, CostShareV2Result>;
  /**
   * dispute_noplan_coverage_request_v1 — when true, the coverage ask is reframed to a
   * plan-document + line-by-line-adjudication REQUEST when no plan is on file to cite,
   * instead of asserting coverage we can't back (Evidence Disclosure Rule). Caller passes
   * the flag state. Default false → byte-identical.
   */
  noPlanCoverageRequestOn?: boolean;
  /**
   * dispute-letters v2 S2 — escalation / collections gate inputs threaded to the template body.
   * User-supplied via the request body at launch (the FE collects them in S5/S6). Fail-closed:
   * absent → the gated clause is OMITTED (renderGated), never a placeholder.
   */
  priorContactDates?: string[];
  certifiedMail?: boolean;
  appealExhausted?: { attested: boolean; denialDate?: string | null };
  collector?: { name: string; address?: string | null; originalCreditor?: string | null };
  debtWithinWindow?: boolean;
}

export function generateDisputeLetter(
  report: AuditReport,
  findingIds: string[],
  letterType?: DisputeLetterType,
  optionsOrPlanEvidence?: GenerateDisputeLetterOptions | PlanBenefitEvidence[]
): DisputeLetter | null {
  const findings = report.findings.filter((f) => findingIds.includes(f.id));

  if (findings.length === 0) {
    throw new Error("No matching findings for the provided IDs");
  }

  // Back-compat: callers used to pass `planEvidence` as the 4th arg directly.
  // Newer callers pass `{ planEvidence, planContext, evidence }`.
  const options: GenerateDisputeLetterOptions = Array.isArray(optionsOrPlanEvidence)
    ? { planEvidence: optionsOrPlanEvidence }
    : (optionsOrPlanEvidence ?? {});
  const { planEvidence, planContext, evidence, gateUnverified, enforceDataTrustGate, disputeGroundsOn, disputeGroundBasis, noPlanCoverageRequestOn,
    priorContactDates, certifiedMail, appealExhausted, collector, debtWithinWindow } =
    options;

  // Resolve the letter type up front (was below, before the template lookup) so the recovery fold
  // can be recipient-aware. R3 step 5.4 (1a) — the set/claim tiers fold into the headline ONLY for
  // the provider letter; deriving the recipient from this resolvedType (the SAME value used to pick
  // the template + returned as letter.letterType) keeps amount_disputed == the letter body per
  // recipient.
  const resolvedType =
    letterType || FINDING_TO_LETTER[findings[0].type] || "overcharge";
  const recipientKind = letterRecipientKind(resolvedType);

  // §18 incr-4 — the per-line deductible-aware letter dollars (== the card recovery), used by
  // the request block to source refund/write-off from the engine, not the deductible-blind
  // discrepancyAmount. Only when the flag is ON AND a basis was loaded → otherwise undefined
  // (the templates fall back to discrepancyAmount → byte-identical).
  // R3 step 5.3 — the FULL recovery (byLine + set/claim tiers + clampBound) drives the multi-charge
  // letter asks; the OFF / no-basis path leaves it undefined → byte-identical.
  const recovery =
    disputeGroundsOn && evidence && disputeGroundBasis
      ? resolveLetterRecovery(evidence, disputeGroundBasis, recipientKind)
      : undefined;
  const letterRecovery = recovery?.byLine;

  // Block A — data-trust HARD STOP. A bill that failed header reconciliation has
  // numbers we don't trust enough to cite, so we suppress generation and let the
  // caller surface the "checking this bill" banner. Flag-gated by the caller
  // (default OFF → status quo). §1a.
  if (enforceDataTrustGate && evidence?.dataTrust?.headerReconciliationFailed) {
    return null;
  }

  const template = LETTER_TEMPLATES[resolvedType];
  if (!template) {
    throw new Error(`Unknown letter type: ${resolvedType}`);
  }

  const bill = report.parsedBill;

  const body = template.body({
    patientName: bill.patient.name,
    providerName: bill.provider.name,
    serviceDate: bill.serviceDate,
    findings,
    bill,
    planEvidence,
    planContext: planContext ?? null,
    evidence: evidence ?? null,
    gateUnverified: gateUnverified ?? false,
    // Block C2 item 4 — the caller passes the dispute_letter_v3_design flag as
    // enforceDataTrustGate; it is the same flag that switches on the request tree.
    v3DesignOn: enforceDataTrustGate ?? false,
    disputeGroundsOn: disputeGroundsOn ?? false,
    letterRecovery,
    recovery,
    noPlanCoverageRequestOn: noPlanCoverageRequestOn ?? false,
    priorContactDates,
    certifiedMail,
    appealExhausted,
    collector,
    debtWithinWindow,
  });

  // Recipient: insurance appeals use insurer + appeals address when available;
  // fall back to provider for billing-department letters.
  // dispute-letters v2 S2 — recipient metadata is recipientKind-aware (was isAppeal-only): insurer
  // letters (insurance_appeal + external_review) → Appeals; collector (debt_validation) → the
  // user-supplied collector; everything else → provider Compliance. insurance_appeal behavior is
  // unchanged (recipientKind==="insurer" && insurer ≡ the prior isAppeal && insurer guard for it).
  const insurer = planContext?.insurer ?? null;
  const hasInsurerAddress = !!insurer?.appealsAddress;

  const recipient =
    recipientKind === "insurer" && insurer
      ? {
          name: insurer.name,
          role: "Appeals Department",
          address: hasInsurerAddress
            ? formatAppealsAddress(insurer.appealsAddress!)
            : undefined,
          phone: insurer.appealsPhone ?? undefined,
        }
      : recipientKind === "collector"
        ? {
            name: collector?.name ?? "The debt collector",
            role: "",
            address: collector?.address ?? undefined,
          }
        : {
            name: bill.provider.name,
            role: "Compliance Department",
            address: bill.provider.address,
          };

  return {
    id: randomUUID(),
    auditReportId: report.id,
    userId: report.userId,
    letterType: resolvedType,
    findingIds,
    recipient,
    subject: template.subject(bill.provider.name),
    body,
    supportingFacts: findings.map((f) => f.description),
    legalBasis: getLegalBasis(resolvedType),
    requestedAction: getRequestedAction(resolvedType, findings),
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    planContext: planContext?.plan
      ? {
          planName: planContext.plan.planName,
          planYear: planContext.plan.planYear,
          insurerName: planContext.insurer?.name ?? planContext.plan.insurerName,
        }
      : planContext
      ? { planName: null, planYear: null, insurerName: planContext.insurer?.name ?? null }
      : null,
    missingPlanForYear: planContext?.missingForYear ?? null,
  };
}

function formatAppealsAddress(addr: {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
}): string {
  const cityStateZip = [addr.city, addr.state, addr.postalCode]
    .filter(Boolean)
    .join(", ")
    .replace(`, ${addr.postalCode}`, ` ${addr.postalCode}`);
  return [addr.line1, addr.line2, cityStateZip].filter(Boolean).join("\n");
}

export function generateItemizedBillRequest(
  bill: {
    patientName: string;
    providerName: string;
    serviceDate: string;
    accountNumber?: string;
  }
): DisputeLetter {
  const template = LETTER_TEMPLATES.itemized_request;

  const body = template.body({
    patientName: bill.patientName,
    providerName: bill.providerName,
    serviceDate: bill.serviceDate,
    accountNumber: bill.accountNumber,
    findings: [],
    bill: {
      provider: { name: bill.providerName },
      patient: { name: bill.patientName },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  });

  return {
    id: randomUUID(),
    auditReportId: "",
    userId: "",
    letterType: "itemized_request",
    findingIds: [],
    recipient: {
      name: bill.providerName,
      role: "Compliance Department",
    },
    subject: template.subject(bill.providerName),
    body,
    supportingFacts: [],
    requestedAction: "Provide a complete itemized bill with CPT codes and line-item pricing",
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function getLegalBasis(type: DisputeLetterType): string {
  switch (type) {
    case "balance_billing":
      return "No Surprises Act (Public Law 116-260), applicable state balance billing protections";
    case "insurance_appeal":
      return "Affordable Care Act Section 2719, ERISA Section 503 (if employer-sponsored plan)";
    case "overcharge":
    case "duplicate_charge":
      return "State consumer protection laws, Fair Debt Collection Practices Act (if in collections)";
    case "itemized_request":
      return "HIPAA Section 164.524 (right of access), state itemized bill laws";
    case "negotiation":
      return "State consumer protection laws, fair pricing standards";
    case "final_notice":
      return "State consumer protection laws; No Surprises Act (Public Law 116-260) where applicable";
    case "external_review":
      return "Affordable Care Act Section 2719, 45 CFR §147.136 (external review)";
    case "debt_validation":
      return "Fair Debt Collection Practices Act (15 U.S.C. §1692g, §1692e(8))";
    default: {
      // Exhaustiveness guard — a new DisputeLetterType without a case here is a compile error.
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function getRequestedAction(
  type: DisputeLetterType,
  findings: AuditFinding[]
): string {
  const total = findings.reduce((sum, f) => sum + f.estimatedOvercharge, 0);

  switch (type) {
    case "overcharge":
      return `Review and adjust overcharges totaling approximately $${total.toFixed(2)}`;
    case "duplicate_charge":
      return `Remove duplicate charges totaling approximately $${total.toFixed(2)}`;
    case "balance_billing":
      return `Adjust bill to reflect only legitimate cost-sharing obligations`;
    case "insurance_appeal":
      return `Reverse claim denial and process for payment under plan benefits`;
    case "itemized_request":
      return `Provide complete itemized bill with procedure codes and line-item pricing`;
    case "negotiation":
      return `Negotiate a fair self-pay rate based on community and Medicare benchmarks`;
    case "final_notice":
      return `Correct the disputed charges within 15 business days before I escalate to regulators`;
    case "external_review":
      return `Initiate an independent external review of the denied claim`;
    case "debt_validation":
      return `Validate the debt and mark it as disputed pending validation`;
    default: {
      // Exhaustiveness guard — a new DisputeLetterType without a case here is a compile error.
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
