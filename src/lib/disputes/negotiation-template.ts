/**
 * Negotiation Letter Template — for uninsured users negotiating self-pay rates.
 *
 * Uses Medicare benchmark + community pricing to establish a fair rate.
 * CROA compliant: user reviews, edits, and sends the letter themselves.
 */
import { renderGated } from "./templates";

export interface NegotiationParams {
  patientName: string;
  providerName: string;
  serviceName: string;
  serviceDate?: string;
  billedAmount?: number;
  medicareBenchmark: number | null;
  communityMedian: number | null;
  suggestedRate: number;
  communityReportCount: number;
}

export function generateNegotiationLetter(params: NegotiationParams): string {
  const {
    patientName,
    providerName,
    serviceName,
    serviceDate,
    billedAmount,
    medicareBenchmark,
    communityMedian,
    suggestedRate,
    communityReportCount,
  } = params;

  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const benchmarkLines: string[] = [];
  if (medicareBenchmark) {
    benchmarkLines.push(`- The Medicare national rate for this service is $${medicareBenchmark.toLocaleString()}`);
  }
  if (communityMedian) {
    benchmarkLines.push(`- The community median based on ${communityReportCount} anonymized reports is $${communityMedian.toLocaleString()}`);
  }

  return `${today}

${providerName}
Compliance Department

Re: Self-Pay Rate Negotiation${renderGated(serviceDate, (d) => ` — Date of Service: ${d}`)}
Patient: ${patientName}

To Whom It May Concern:

I am writing to discuss the charges for ${serviceName}${renderGated(serviceDate, (d) => ` received on ${d}`)}. As a self-pay patient, I am requesting a fair rate for this service based on publicly available pricing data.
${billedAmount ? `
My current bill shows a charge of $${billedAmount.toLocaleString()} for this service.
` : ""}
Based on my research, fair market rates for this service are significantly lower:

${benchmarkLines.join("\n")}

I am requesting a self-pay rate of $${suggestedRate.toLocaleString()} for this service, which represents a fair rate based on the benchmarks above.

I would also like to request information about:

1. Your facility's self-pay or cash-pay rate for this service
2. Any financial assistance programs or charity care programs I may qualify for
3. Payment plan options if available

I am committed to paying a fair rate for the care I received and would appreciate the opportunity to discuss this further. Please contact me at your earliest convenience.

Sincerely,

${patientName}

---
DISCLAIMER: This letter is informational only. Candid does not negotiate on your behalf and does not provide legal advice. You are responsible for reviewing, sending, and managing all communications with providers. Consider consulting a patient advocate or attorney for complex billing disputes.`;
}
