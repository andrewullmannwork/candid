/**
 * Cost-Share v2 (W3) — pure parser/validator for the user-facing cost-share-override
 * request body. Keeps the route thin: this validates + normalizes one correction (the §5
 * banner editor toggles one chip at a time), the route resolves context + writes user-scoped.
 *
 * Coinsurance contract: the body sends `coinsurancePercent` (0-100, what the §5 "Coinsurance
 * %" UI shows); we store the DECIMAL fraction (S215 canonical — the column is uniformly
 * decimal) so the engine + corroboration never hit the percent/decimal split.
 */

export type CostShareOverrideParsed =
  | { field: "network"; value: "in_network" | "out_of_network" }
  | { field: "deductible_met"; met: boolean; asOf: string | null }
  | { field: "oop_met"; met: boolean; asOf: string | null }
  | {
      field: "service_cost";
      serviceSlug: string;
      copay: number | null;
      coinsurance: number | null; // decimal 0-1
      deductibleApplies: boolean | null;
    }
  | { field: "aca"; status: "confirmed" | "non_aca" };

export type ParseResult =
  | { ok: true; value: CostShareOverrideParsed }
  | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isValidIsoDate = (s: string): boolean =>
  ISO_DATE.test(s) && !Number.isNaN(Date.parse(s));

export function parseCostShareOverride(body: unknown): ParseResult {
  if (!body || typeof body !== "object") return { ok: false, error: "body required" };
  const b = body as Record<string, unknown>;

  switch (b.field) {
    case "network": {
      if (b.value !== "in_network" && b.value !== "out_of_network") {
        return { ok: false, error: "network value must be in_network or out_of_network" };
      }
      return { ok: true, value: { field: "network", value: b.value } };
    }

    case "deductible_met":
    case "oop_met": {
      if (typeof b.met !== "boolean") {
        return { ok: false, error: `${b.field} requires met (boolean)` };
      }
      let asOf: string | null = null;
      if (b.asOf != null) {
        if (typeof b.asOf !== "string" || !isValidIsoDate(b.asOf)) {
          return { ok: false, error: "asOf must be an ISO date (YYYY-MM-DD)" };
        }
        asOf = b.asOf;
      }
      // an as-of date only makes sense when marking MET (the §5 "met as of …" sub-panel).
      if (!b.met && asOf) {
        return { ok: false, error: "asOf is only valid when met=true" };
      }
      return { ok: true, value: { field: b.field, met: b.met, asOf } };
    }

    case "service_cost": {
      if (typeof b.serviceSlug !== "string" || b.serviceSlug.length === 0) {
        return { ok: false, error: "service_cost requires serviceSlug" };
      }
      let copay: number | null = null;
      if (b.copay != null) {
        if (typeof b.copay !== "number" || !Number.isFinite(b.copay) || b.copay < 0) {
          return { ok: false, error: "copay must be a number >= 0" };
        }
        copay = Math.round(b.copay * 100) / 100;
      }
      let coinsurance: number | null = null;
      if (b.coinsurancePercent != null) {
        if (
          typeof b.coinsurancePercent !== "number" ||
          !Number.isFinite(b.coinsurancePercent) ||
          b.coinsurancePercent < 0 ||
          b.coinsurancePercent > 100
        ) {
          return { ok: false, error: "coinsurancePercent must be a number 0-100" };
        }
        coinsurance = Math.round(b.coinsurancePercent) / 100; // store decimal
      }
      if (copay == null && coinsurance == null) {
        return { ok: false, error: "service_cost requires copay or coinsurancePercent" };
      }
      let deductibleApplies: boolean | null = null;
      if (b.deductibleApplies != null) {
        if (typeof b.deductibleApplies !== "boolean") {
          return { ok: false, error: "deductibleApplies must be a boolean" };
        }
        deductibleApplies = b.deductibleApplies;
      }
      return {
        ok: true,
        value: { field: "service_cost", serviceSlug: b.serviceSlug, copay, coinsurance, deductibleApplies },
      };
    }

    case "aca": {
      if (b.status !== "confirmed" && b.status !== "non_aca") {
        return { ok: false, error: "aca status must be confirmed or non_aca" };
      }
      return { ok: true, value: { field: "aca", status: b.status } };
    }

    default:
      return { ok: false, error: `unknown field: ${String(b.field)}` };
  }
}
