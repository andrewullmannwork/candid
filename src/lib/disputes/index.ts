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
import { randomUUID } from "crypto";

export type { PlanBenefitEvidence };

// Map finding types to appropriate letter types
const FINDING_TO_LETTER: Partial<Record<FindingType, DisputeLetterType>> = {
  overcharge: "overcharge",
  duplicate: "duplicate_charge",
  unbundling: "overcharge",
  upcoding: "overcharge",
  balance_billing: "balance_billing",
  missing_adjustment: "overcharge",
  stale_claim: "overcharge",
};

export interface GenerateDisputeLetterOptions {
  planEvidence?: PlanBenefitEvidence[];
  planContext?: PlanContext | null;
  evidence?: DisputeEvidence | null;
}

export function generateDisputeLetter(
  report: AuditReport,
  findingIds: string[],
  letterType?: DisputeLetterType,
  optionsOrPlanEvidence?: GenerateDisputeLetterOptions | PlanBenefitEvidence[]
): DisputeLetter {
  const findings = report.findings.filter((f) => findingIds.includes(f.id));

  if (findings.length === 0) {
    throw new Error("No matching findings for the provided IDs");
  }

  // Back-compat: callers used to pass `planEvidence` as the 4th arg directly.
  // Newer callers pass `{ planEvidence, planContext, evidence }`.
  const options: GenerateDisputeLetterOptions = Array.isArray(optionsOrPlanEvidence)
    ? { planEvidence: optionsOrPlanEvidence }
    : (optionsOrPlanEvidence ?? {});
  const { planEvidence, planContext, evidence } = options;

  // Auto-detect letter type from findings if not specified
  const resolvedType =
    letterType || FINDING_TO_LETTER[findings[0].type] || "overcharge";

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
  });

  // Recipient: insurance appeals use insurer + appeals address when available;
  // fall back to provider for billing-department letters.
  const isAppeal = resolvedType === "insurance_appeal";
  const insurer = planContext?.insurer ?? null;
  const hasInsurerAddress = !!insurer?.appealsAddress;

  const recipient = isAppeal && insurer
    ? {
        name: insurer.name,
        role: "Member Services — Appeals",
        address: hasInsurerAddress
          ? formatAppealsAddress(insurer.appealsAddress!)
          : undefined,
        phone: insurer.appealsPhone ?? undefined,
      }
    : {
        name: bill.provider.name,
        role: isAppeal ? "Insurance Appeals Department" : "Billing Department",
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
      role: "Billing Department",
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
  }
}
