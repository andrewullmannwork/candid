/**
 * Cost-share display formatting — THE structured-columns → display-string
 * rule for benefit cost cells (S289; extracted verbatim from the
 * /api/plan/analyze route closures).
 *
 * Why a shared module: the analyze response carries BOTH structured values
 * (copay/coinsurance/deductibleApplies) and a pre-formatted `costDescription`,
 * and the /plan matrix + single-variant panel render ONLY the string. The
 * S289 leg-③ bug was one producer (canonical gap-fill) minting "" while the
 * user-row producer minted real strings — every canonical benefit rendered
 * "—" in both network columns. With the formatters extracted, every producer
 * calls the same named unit and the fixture asserts its output directly;
 * an empty-string producer can't reappear silently.
 *
 * Both coverage tables carry the aligned column names these read
 * (in_copay/in_coinsurance/in_deductible_applies + out_* — F.0 migs 165/169),
 * so rows from plan_covered_services AND canonical_plan_services format
 * identically by construction.
 *
 * Known sibling: src/lib/plan/compare.ts `describeCost` is an independent
 * implementation of the same idea (option-bag input, slightly different
 * phrasing). Unifying it onto this module is a logged follow-up — not bundled
 * into the S289 launch PR.
 */

import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";

/** The aligned cost-share columns (subset) both coverage tables share. */
export interface CostShareRow {
  in_copay?: number | null;
  in_coinsurance?: number | null;
  in_deductible_applies?: boolean | null;
  out_copay?: number | null;
  out_coinsurance?: number | null;
  out_deductible_applies?: boolean | null;
  /** SBC-parser prose (plan_covered_services only); preferred when present. */
  out_cost_description?: string | null;
}

/** In-network: "$115 copay" · "40% coinsurance, after deductible" · "No charge" · "Covered". */
export function formatInNetworkCost(s: CostShareRow): string {
  const parts: string[] = [];
  const copay = s.in_copay ?? null;
  const coinsurance = s.in_coinsurance ?? null;
  if (copay != null) parts.push(`$${copay} copay`);
  if (coinsurance != null && coinsurance > 0) parts.push(`${normalizeCoinsurancePct(coinsurance)}% coinsurance`);
  if (s.in_deductible_applies) parts.push("after deductible");
  if (parts.length === 0 && copay === null && coinsurance === 0) return "No charge";
  if (parts.length === 0) return "Covered";
  return parts.join(", ").replace(/^./, (c: string) => c.toUpperCase());
}

/**
 * Out-of-network: extracted prose wins; else structured fields; else an
 * honest default — HMO/EPO plans typically don't cover OON, so signal
 * "Not covered" instead of an empty em-dash.
 */
export function formatOutOfNetworkCost(s: CostShareRow, planType: string | null): string {
  const prose = s.out_cost_description?.trim();
  if (prose) return prose;
  const parts: string[] = [];
  const copay = s.out_copay ?? null;
  const coinsurance = s.out_coinsurance ?? null;
  if (copay != null) parts.push(`$${copay} copay`);
  if (coinsurance != null && coinsurance > 0) parts.push(`${normalizeCoinsurancePct(coinsurance)}% coinsurance`);
  if (s.out_deductible_applies) parts.push("after deductible");
  if (parts.length > 0) return parts.join(", ").replace(/^./, (c: string) => c.toUpperCase());
  if (copay === 0 && coinsurance === 0) return "No charge";
  const pt = (planType || "").toUpperCase();
  if (pt === "HMO" || pt === "EPO") return "Not covered";
  return "";
}
