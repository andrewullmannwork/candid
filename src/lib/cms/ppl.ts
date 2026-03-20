// CMS Physician/Practitioner Payment Lookup (PPL) API client
// Free, no API key required — provides Medicare national average by CPT code
// Source: https://data.cms.gov/provider-data/

import type { CMSPPLRate } from "../billing/types";

const CMS_API_BASE =
  "https://data.cms.gov/provider-data/api/1/datastore/query/";

// CMS Medicare Physician & Other Practitioners dataset identifier
// This is the public dataset for Medicare payment amounts by HCPCS code
const DATASET_ID = "medicare-physician-other-practitioners";

interface CMSAPIResponse {
  results: Array<{
    hcpcs_cd: string;
    modifier: string;
    average_medicare_allowed_amt: string;
    average_submitted_chrg_amt: string;
    average_medicare_payment_amt: string;
  }>;
  count: number;
}

// In-memory cache to avoid hammering the API
const rateCache = new Map<string, CMSPPLRate>();

export async function lookupCMSRate(
  procedureCode: string,
  modifier?: string
): Promise<CMSPPLRate | null> {
  const cacheKey = `${procedureCode}-${modifier || "none"}`;
  if (rateCache.has(cacheKey)) return rateCache.get(cacheKey)!;

  try {
    const params = new URLSearchParams({
      "filter[hcpcs_cd]": procedureCode,
      limit: "10",
    });

    if (modifier) {
      params.set("filter[modifier]", modifier);
    }

    const response = await fetch(
      `${CMS_API_BASE}${DATASET_ID}?${params.toString()}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      console.error(`CMS PPL API error: ${response.status}`);
      return null;
    }

    const data: CMSAPIResponse = await response.json();

    if (!data.results || data.results.length === 0) return null;

    // Average across all returned rows (different providers/localities)
    let totalAllowed = 0;
    let count = 0;

    for (const row of data.results) {
      const amt = parseFloat(row.average_medicare_allowed_amt);
      if (!isNaN(amt) && amt > 0) {
        totalAllowed += amt;
        count++;
      }
    }

    if (count === 0) return null;

    const rate: CMSPPLRate = {
      procedureCode,
      modifier,
      nationalAverage: Math.round((totalAllowed / count) * 100) / 100,
      year: new Date().getFullYear(),
      source: "cms_ppl",
    };

    rateCache.set(cacheKey, rate);
    return rate;
  } catch (error) {
    console.error("CMS PPL lookup failed:", error);
    return null;
  }
}

export async function lookupCMSRatesBatch(
  codes: Array<{ code: string; modifier?: string }>
): Promise<Map<string, CMSPPLRate>> {
  const results = new Map<string, CMSPPLRate>();

  // Process in batches of 5 to avoid overwhelming the API
  const batchSize = 5;
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize);
    const promises = batch.map(({ code, modifier }) =>
      lookupCMSRate(code, modifier).then((rate) => {
        if (rate) results.set(code, rate);
      })
    );
    await Promise.all(promises);
  }

  return results;
}
