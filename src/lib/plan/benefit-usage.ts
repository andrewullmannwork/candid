/**
 * "I use this benefit" tick persistence (S289).
 *
 * Ticks live on the ACTIVE insurance_plans row at metadata.used_benefits — an
 * array of LIVE service_catalog slugs. That placement is deliberate:
 *   - account-level (any device/browser), unlike the localStorage set this
 *     replaced (which was also TITLE-keyed, so /plan wrote names the
 *     /dashboard tile counter — slug-keyed — could never match, and every
 *     display rename orphaned ticks);
 *   - per-plan: ticks describe THIS plan's benefits; replacing the plan
 *     naturally starts fresh;
 *   - slug-keyed + live-normalized: display renames can't orphan them, and
 *     catalog merges are absorbed by resolving through loadCatalogIdentity
 *     at write time.
 *
 * These helpers are pure (fixture-asserted); the route + analyze response do
 * the IO.
 */

/** Sanity cap — a plan has ~dozens of benefits; anything near this is garbage. */
export const USED_BENEFITS_CAP = 300;

/** metadata.used_benefits → clean string[] (tolerates absent/garbage metadata). */
export function readUsedBenefits(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).used_benefits;
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(raw.filter((s): s is string => typeof s === "string" && s.length > 0)),
  ).sort();
}

/**
 * Apply a toggle to the stored set. `add` entries should already be normalized
 * to LIVE slugs by the caller; `remove` entries are removed verbatim (callers
 * pass every known form — raw + live — so stale pre-normalization ticks clear
 * too). Result is deduped, sorted (stable diffs), and capped.
 */
export function applyUsedBenefitsToggle(
  metadata: unknown,
  opts: { add?: string[]; remove?: string[] },
): string[] {
  const next = new Set(readUsedBenefits(metadata));
  for (const slug of opts.remove ?? []) next.delete(slug);
  for (const slug of opts.add ?? []) {
    if (typeof slug === "string" && slug.length > 0) next.add(slug);
  }
  return Array.from(next).sort().slice(0, USED_BENEFITS_CAP);
}
