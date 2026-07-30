/**
 * The named author behind the /learn guides.
 *
 * Why this exists: these are YMYL pages (health and money), where Google's
 * quality systems and the AI answer engines both weight attributable
 * expertise. Guides authored by an Organization carry noticeably less of that
 * signal than guides authored by an identifiable person who stands behind
 * them. One author today; this shape supports more later.
 */

export const AUTHOR = {
  name: "Andrew Ullmann",
  /** Author page — the canonical URL for the Person entity. */
  path: "/about",
  role: "Founder, Candid",
  /**
   * Shown under every guide's byline. Kept factual: what he does and why he
   * built the tool. No credential claims we cannot stand behind.
   */
  bio: "Andrew Ullmann is the founder of Candid. He built it after going line by line through his own medical bills and finding that the numbers on them frequently did not survive a careful check. He writes these guides from the same process the product automates: get the itemized bill, match it to the explanation of benefits, and dispute what does not hold up.",
  /**
   * Personal profiles for the Person entity. Deliberately EMPTY for now: the
   * LinkedIn page on file (linkedin.com/company/candidclaim) is the COMPANY,
   * and it already sits on the Organization's `sameAs`. Putting an
   * organization URL on a Person conflates two different entities and weakens
   * both. Add a personal profile URL here when there is one.
   */
  sameAs: [] as string[],
} as const;
