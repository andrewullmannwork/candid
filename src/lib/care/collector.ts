// Candid Care — Pricing data collector
// Extracts anonymized pricing data from processed bills and stores it
// for the Candid Care price transparency tool.

import type { ParsedBill } from "@/lib/billing/types";
import { createServerClient } from "@/lib/supabase/server";

interface PricingDataPoint {
  procedure_code: string;
  procedure_category: string | null;
  facility_name: string | null;
  facility_npi: string | null;
  region: string;
  billed_amount: number | null;
  allowed_amount: number | null;
  insurance_paid: number | null;
  patient_paid: number | null;
  data_source: "user_bill";
  confidence_score: number;
  source_document_id: string;
  service_date: string | null;
}

/**
 * Extract pricing data points from a parsed bill and store them.
 * Called after a bill is successfully processed through the audit pipeline.
 * Data is anonymized — no patient info is stored.
 */
export async function collectPricingData(
  bill: ParsedBill,
  userState: string | null
): Promise<{ collected: number; errors: string[] }> {
  const errors: string[] = [];

  // Determine region from bill provider address or user profile state
  const region = extractRegion(bill, userState);
  if (!region) {
    return { collected: 0, errors: ["Could not determine region for pricing data"] };
  }

  const dataPoints: PricingDataPoint[] = [];

  for (const item of bill.lineItems) {
    if (!item.procedureCode) continue;

    // Only collect if we have at least a billed amount
    if (!item.billedAmount || item.billedAmount <= 0) continue;

    dataPoints.push({
      procedure_code: item.procedureCode,
      procedure_category: item.category || null,
      facility_name: bill.provider.name || null,
      facility_npi: bill.provider.npi || null,
      region,
      billed_amount: item.billedAmount,
      allowed_amount: item.allowedAmount || null,
      insurance_paid: item.insurancePaid || null,
      patient_paid: item.patientResponsibility || null,
      data_source: "user_bill",
      confidence_score: 0.75, // User bills are higher confidence than public data
      source_document_id: bill.documentId,
      service_date: item.serviceDate || null,
    });
  }

  if (dataPoints.length === 0) {
    return { collected: 0, errors: [] };
  }

  // Batch insert
  const supabase = createServerClient();
  const { error } = await supabase.from("pricing_data").insert(dataPoints);

  if (error) {
    errors.push(`Failed to store pricing data: ${error.message}`);
    return { collected: 0, errors };
  }

  return { collected: dataPoints.length, errors: [] };
}

function extractRegion(bill: ParsedBill, userState: string | null): string | null {
  // Try to extract state from provider address
  if (bill.provider.address) {
    const stateMatch = bill.provider.address.match(
      /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/
    );
    if (stateMatch) return stateMatch[1];
  }

  // Fall back to user's profile state
  return userState;
}
