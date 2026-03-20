// Dispute letter templates — populated with facts from audit findings
// User reviews, edits, approves, and downloads. User sends letter themselves.

import type { AuditFinding, ParsedBill, DisputeLetterType } from "../billing/types";

interface LetterTemplate {
  type: DisputeLetterType;
  subject: (provider: string) => string;
  body: (params: TemplateParams) => string;
}

interface TemplateParams {
  patientName: string;
  providerName: string;
  serviceDate: string;
  accountNumber?: string;
  findings: AuditFinding[];
  bill: ParsedBill;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ============================================================================
// TEMPLATE: Overcharge Dispute
// ============================================================================

const overchargeTemplate: LetterTemplate = {
  type: "overcharge",
  subject: (provider) => `Billing Dispute — Request for Review and Adjustment — ${provider}`,
  body: ({
    patientName,
    providerName,
    serviceDate,
    accountNumber,
    findings,
  }) => {
    const findingDetails = findings
      .map(
        (f, i) =>
          `${i + 1}. ${f.title}\n   Billed amount: ${formatCurrency(f.billedAmount)}${f.benchmarkAmount ? `\n   Medicare national average: ${formatCurrency(f.benchmarkAmount)}` : ""}\n   Estimated overcharge: ${formatCurrency(f.estimatedOvercharge)}\n   ${f.description}`
      )
      .join("\n\n");

    const totalOvercharge = findings.reduce(
      (sum, f) => sum + f.estimatedOvercharge,
      0
    );

    return `${formatDate(new Date().toISOString())}

${providerName}
Billing Department

Re: Billing Dispute — Date of Service: ${formatDate(serviceDate)}
Patient: ${patientName}${accountNumber ? `\nAccount #: ${accountNumber}` : ""}

To Whom It May Concern:

I am writing to formally dispute charges on my medical bill for services rendered on ${formatDate(serviceDate)}. After reviewing my bill and comparing the charges to publicly available Medicare payment data and standard billing practices, I have identified the following potential discrepancies:

${findingDetails}

The total estimated overcharge across these items is ${formatCurrency(totalOvercharge)}.

I am requesting the following:

1. A detailed, itemized bill showing all charges, procedure codes (CPT/HCPCS), and quantities.
2. A review and explanation of the charges identified above.
3. An appropriate adjustment to my account if these charges are found to be in error.

Under the No Surprises Act and applicable state consumer protection laws, I am entitled to a clear and accurate bill. I request a written response within 30 days of receipt of this letter.

Please send your response to the address above or contact me to discuss this matter.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative. The information above is based on automated analysis of publicly available billing data and may not reflect your specific contractual rates or coverage. You should consult with a qualified attorney if you need legal advice regarding your medical bills.`;
  },
};

// ============================================================================
// TEMPLATE: Itemized Bill Request
// ============================================================================

const itemizedRequestTemplate: LetterTemplate = {
  type: "itemized_request",
  subject: (provider) => `Request for Itemized Bill — ${provider}`,
  body: ({ patientName, providerName, serviceDate, accountNumber }) => {
    return `${formatDate(new Date().toISOString())}

${providerName}
Billing Department

Re: Request for Itemized Bill — Date of Service: ${formatDate(serviceDate)}
Patient: ${patientName}${accountNumber ? `\nAccount #: ${accountNumber}` : ""}

To Whom It May Concern:

I am writing to request a complete itemized bill for services rendered on ${formatDate(serviceDate)}. I am exercising my right under federal and state law to receive a detailed breakdown of all charges.

Please include the following information for each line item:

1. Date of service
2. CPT/HCPCS procedure code
3. Description of the service or supply
4. Quantity
5. Billed amount
6. Insurance-allowed amount (if applicable)
7. Insurance payment (if applicable)
8. Patient responsibility
9. Any adjustments or write-offs applied

Please send the itemized bill to the address above within 30 days of receipt of this request. If there are any questions, please contact me at your earliest convenience.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid does not provide legal advice and does not act as your legal representative.`;
  },
};

// ============================================================================
// TEMPLATE: Insurance Denial Appeal
// ============================================================================

const insuranceAppealTemplate: LetterTemplate = {
  type: "insurance_appeal",
  subject: (provider) => `Appeal of Claim Denial — ${provider}`,
  body: ({
    patientName,
    providerName,
    serviceDate,
    accountNumber,
    findings,
    bill,
  }) => {
    const insurerName = bill.insurer?.name || "[Insurance Company]";
    const memberId = bill.patient.memberId || "[Member ID]";

    return `${formatDate(new Date().toISOString())}

${insurerName}
Appeals Department

Re: Appeal of Claim Denial — Date of Service: ${formatDate(serviceDate)}
Patient: ${patientName}
Member ID: ${memberId}
Provider: ${providerName}${accountNumber ? `\nAccount #: ${accountNumber}` : ""}

To Whom It May Concern:

I am writing to formally appeal the denial of my claim for services rendered on ${formatDate(serviceDate)} by ${providerName}.

The services provided were medically necessary and should be covered under my plan. I am requesting a full review of this denial, including:

1. The specific reason for denial, including the applicable plan provision or exclusion
2. The clinical criteria used to determine medical necessity
3. Instructions for requesting an external review if this internal appeal is denied

Under the Affordable Care Act and applicable state law, I am entitled to a full and fair review of this denial. I request a written determination within the timeframe required by law (generally 30 days for post-service claims).

I reserve all rights to pursue external review and any other remedies available under federal and state law.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid does not provide legal advice and does not act as your legal representative. You should consult with a qualified attorney or patient advocate if you need assistance with your insurance appeal.`;
  },
};

// ============================================================================
// TEMPLATE: Balance Billing Dispute
// ============================================================================

const balanceBillingTemplate: LetterTemplate = {
  type: "balance_billing",
  subject: (provider) => `Balance Billing Dispute — ${provider}`,
  body: ({
    patientName,
    providerName,
    serviceDate,
    accountNumber,
    findings,
  }) => {
    const findingDetails = findings
      .map(
        (f, i) =>
          `${i + 1}. ${f.title}\n   ${f.description}`
      )
      .join("\n\n");

    const totalExcess = findings.reduce(
      (sum, f) => sum + f.estimatedOvercharge,
      0
    );

    return `${formatDate(new Date().toISOString())}

${providerName}
Billing Department

Re: Balance Billing Dispute — Date of Service: ${formatDate(serviceDate)}
Patient: ${patientName}${accountNumber ? `\nAccount #: ${accountNumber}` : ""}

To Whom It May Concern:

I am writing to dispute what appears to be balance billing on my account for services rendered on ${formatDate(serviceDate)}.

After reviewing my Explanation of Benefits and your bill, I have identified charges that exceed my plan's allowed amount minus my insurance payment. Under the No Surprises Act (effective January 1, 2022) and applicable state balance billing protections, I should not be billed for amounts beyond my in-network cost-sharing obligations for covered services.

Specifically:

${findingDetails}

The total excess charges amount to approximately ${formatCurrency(totalExcess)}.

I am requesting:

1. An immediate review of these charges
2. Adjustment of my bill to reflect only my legitimate cost-sharing obligations (copay, coinsurance, and deductible)
3. A corrected bill reflecting the appropriate patient responsibility

Please respond within 30 days. If I do not receive a satisfactory resolution, I intend to file complaints with my state insurance commissioner and the federal No Surprises Help Desk.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid does not provide legal advice and does not act as your legal representative.`;
  },
};

// ============================================================================
// TEMPLATE: Duplicate Charge Dispute
// ============================================================================

const duplicateChargeTemplate: LetterTemplate = {
  type: "duplicate_charge",
  subject: (provider) => `Duplicate Charge Dispute — ${provider}`,
  body: ({
    patientName,
    providerName,
    serviceDate,
    accountNumber,
    findings,
  }) => {
    const findingDetails = findings
      .map(
        (f, i) =>
          `${i + 1}. ${f.title}\n   ${f.description}`
      )
      .join("\n\n");

    const totalDuplicate = findings.reduce(
      (sum, f) => sum + f.estimatedOvercharge,
      0
    );

    return `${formatDate(new Date().toISOString())}

${providerName}
Billing Department

Re: Duplicate Charge Dispute — Date of Service: ${formatDate(serviceDate)}
Patient: ${patientName}${accountNumber ? `\nAccount #: ${accountNumber}` : ""}

To Whom It May Concern:

I am writing to dispute what appear to be duplicate charges on my medical bill for services rendered on ${formatDate(serviceDate)}.

After reviewing my bill, I have identified the following charges that appear to be duplicated:

${findingDetails}

The total amount of suspected duplicate charges is ${formatCurrency(totalDuplicate)}.

I am requesting:

1. A detailed review of each charge listed above
2. Removal of any confirmed duplicate charges
3. A corrected bill reflecting the appropriate total

Please provide a written response within 30 days of receipt of this letter.

Sincerely,

${patientName}

---
DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid does not provide legal advice and does not act as your legal representative.`;
  },
};

// ============================================================================
// TEMPLATE REGISTRY
// ============================================================================

export const LETTER_TEMPLATES: Record<DisputeLetterType, LetterTemplate> = {
  overcharge: overchargeTemplate,
  itemized_request: itemizedRequestTemplate,
  insurance_appeal: insuranceAppealTemplate,
  balance_billing: balanceBillingTemplate,
  duplicate_charge: duplicateChargeTemplate,
};
