// Item C (R3 step 5.4 Phase 3) — chargemaster detector + its rate loader.
//
// The provider billed ABOVE its OWN published standard/average charge (the chargemaster). This is
// the self-referential lever — it works even with NO insurance contract (out-of-network / cash-pay /
// bill-only uploads), which is exactly the gap the contracted-rate ground (Item B) can't reach.
//
// Data source = `pricing_data` rows with `data_source='hospital_hpt'` (the federal Hospital Price
// Transparency disclosure; we REUSE the Care pricing table rather than a new chargemaster table).
// Exact NPI match only — name-matching (fuzzy) is the deferred Care workstream.

import { randomUUID } from "crypto";
import { createServerClient } from "../supabase/server";
import type { AuditFinding, ParsedBill } from "../billing/types";

/**
 * Load the provider's published chargemaster rates for the bill's codes — mirrors
 * `lookupCMSRatesBatch` (cms/ppl.ts): returns `Map<procedureCode, publishedRate>`. INERT-SAFE: no
 * NPI on the bill, no codes, or ANY DB/query error → an EMPTY map (the detector then emits nothing →
 * byte-identical). The runAudit smoke's synthetic bill carries no NPI → this returns empty (no query
 * at all) → the smoke hash is unchanged. Called once upfront by runAudit (the only async/DB seam);
 * the detector itself stays pure.
 */
export async function lookupChargemasterRatesBatch(
  facilityNpi: string | null | undefined,
  codes: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!facilityNpi || codes.length === 0) return out;
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("pricing_data")
      .select("procedure_code, billed_amount")
      .eq("data_source", "hospital_hpt")
      .eq("facility_npi", facilityNpi)
      .in("procedure_code", codes);
    if (error || !data) return out;
    for (const row of data as Array<{ procedure_code: string | null; billed_amount: number | null }>) {
      const code = row.procedure_code;
      const amt = row.billed_amount != null ? Number(row.billed_amount) : null;
      if (code && amt != null && Number.isFinite(amt) && amt > 0 && !out.has(code)) out.set(code, amt);
    }
  } catch {
    return out; // inert on any failure (no DB / no env) — preserves byte-identity
  }
  return out;
}

/**
 * The chargemaster detector — PURE (the async/DB load happened upfront in runAudit, mirroring
 * `benchmarks`). Emits a `chargemaster` finding for each line billed ABOVE the provider's own
 * published average charge. `benchmarkAmount` carries the published rate so buildObligationContext
 * (the `published_rate_exceeded` predicate) + the data-aware letter ask can cite it. RAISE-class:
 * the letter ask hedges ("please review"), never asserts — chargemaster = RAISE, not ASSERT (§4).
 * Empty rate map → no findings (the common path until the hospital_hpt seed lands).
 */
export function checkChargemaster(
  bill: ParsedBill,
  chargemasterRates: Map<string, number>,
): AuditFinding[] {
  if (chargemasterRates.size === 0) return [];
  const findings: AuditFinding[] = [];
  for (const li of bill.lineItems) {
    const published = chargemasterRates.get(li.procedureCode);
    const billed = li.billedAmount;
    if (published == null || !Number.isFinite(billed) || billed <= published) continue;
    findings.push({
      id: randomUUID(),
      type: "chargemaster",
      severity: "medium",
      lineItems: [li.lineNumber],
      title: "Charge above the provider's published rate",
      description: `Billed ${billed} for ${li.procedureCode}; the provider's own published average charge is ${published}.`,
      estimatedOvercharge: Math.round((billed - published) * 100) / 100,
      benchmarkSource: "Provider chargemaster (Hospital Price Transparency)",
      benchmarkAmount: published,
      billedAmount: billed,
      confidence: 0.6,
      actionable: true,
    });
  }
  return findings;
}
