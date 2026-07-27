/**
 * groupCoveredBenefits — THE shared "how many benefits does this plan have"
 * counting rule (S289).
 *
 * /plan renders ONE row (and one checkbox) per distinct display TITLE within
 * a category — POS/component/tier variants of the same service stack inside
 * that row. Before this helper, /dashboard counted raw benefit ITEMS instead:
 * a 3-variant Surgery showed as 3 on the tile but 1 row on /plan, and one
 * tick on a slug shared by 2 variant items bumped the tile's used-count by 2.
 * Both surfaces now derive their denominators (and tick lookups) from this
 * one grouping.
 *
 * Covered-only: `covered === false` items live in the separate Not-Covered
 * section on /plan, so they never count toward tiles or scoreboards.
 */

interface BenefitLike {
  covered?: boolean | null;
  benefit: { id: string; title: string; category: string };
}

export interface CoveredBenefitGroup {
  /** Display title — the /plan row identity. */
  title: string;
  /** Category of the group's first-seen item (drives tiles + deep-links). */
  category: string;
  /** Every distinct benefit id (service slug) stacked under this title. */
  slugs: string[];
}

export function groupCoveredBenefits(
  benefits: ReadonlyArray<BenefitLike>,
): CoveredBenefitGroup[] {
  const byTitle = new Map<string, CoveredBenefitGroup>();
  for (const item of benefits) {
    if (item.covered === false) continue;
    const title = item.benefit.title;
    let group = byTitle.get(title);
    if (!group) {
      group = { title, category: item.benefit.category, slugs: [] };
      byTitle.set(title, group);
    }
    if (!group.slugs.includes(item.benefit.id)) group.slugs.push(item.benefit.id);
  }
  return Array.from(byTitle.values());
}

/** True when any of the group's variant slugs is in the ticked set. */
export function isGroupUsed(
  group: CoveredBenefitGroup,
  usedBenefits: ReadonlySet<string>,
): boolean {
  return group.slugs.some((s) => usedBenefits.has(s));
}
