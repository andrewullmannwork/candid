/**
 * B3.3 — Universal coinsurance value normalization.
 *
 * Background: coinsurance is stored as a decimal (0.30 = 30%) by design, but
 * parser and writer drift have left legacy + stale rows where the value is
 * stored as a percentage (30 = 30%) or even garbage. The "$3000% coinsurance"
 * trap was the user-visible symptom; this helper is the display-layer defense
 * shared across every consumer that formats coinsurance for users.
 *
 * Strategy:
 *   - raw > 1   → treat as already-a-percentage (e.g., 30 → 30%; 40 → 40%)
 *   - raw <= 1  → treat as decimal (e.g., 0.30 → 30%; 0.5 → 50%)
 *   - Clamp to [0, 100] — never render > 100% (which is nonsensical for coinsurance).
 *
 * Use `normalizeCoinsurancePct` when you want the integer percentage value
 * (e.g., for "$X% coinsurance" copy). Use `normalizeCoinsuranceDecimal` when
 * you need the decimal for dollar math (e.g., billed * coinsurance = user pays).
 *
 * NON-NEGOTIABLE preservation list (Subplan §1.C.3): all coinsurance display
 * across claim / case / care / plan / benefits / compare uses these helpers
 * for defense-in-depth against writer-side data corruption.
 */

/** Returns the integer percentage value of coinsurance, clamped to [0, 100]. */
export function normalizeCoinsurancePct(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const asPercent = raw > 1 ? raw : raw * 100;
  return Math.min(100, Math.max(0, Math.round(asPercent)));
}

/** Returns the decimal value of coinsurance in [0, 1] for dollar math. */
export function normalizeCoinsuranceDecimal(raw: number): number {
  return normalizeCoinsurancePct(raw) / 100;
}

/**
 * Writer-side normalization at the parser → storage boundary.
 *
 * Storage convention: coinsurance is a decimal in [0, 1]. Claude's extractor
 * is instructed to return decimal (`0.10` for 10%) but occasionally returns
 * percentage (`30` for 30%) instead. Pre-fix, the raw value was stored as-is,
 * which then surfaced as "3000% coinsurance" through every display formatter
 * that multiplies by 100.
 *
 * Apply at every INSERT into `plan_covered_services` / `canonical_plan_services`
 * (in_coinsurance + out_coinsurance) to normalize at the type boundary instead
 * of relying on display-layer defense alone.
 *
 * Behaviour:
 *   - null / undefined / non-finite → null (no value to store)
 *   - raw <= 0  → 0 (no coinsurance)
 *   - raw > 1   → raw / 100 (Claude returned percentage; convert to decimal)
 *   - raw ≤ 1   → raw (already a decimal, preserve precision; no rounding)
 *   - Always clamped to [0, 1].
 */
export function normalizeCoinsuranceForStorage(
  raw: number | null | undefined,
): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  if (raw <= 0) return 0;
  const asDecimal = raw > 1 ? raw / 100 : raw;
  return Math.min(1, asDecimal);
}
