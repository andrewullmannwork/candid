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
   * Shown in the author box on every guide and on /about — Andrew-approved
   * final wording (copy sheet v6.2, 2026-07-30). Factual, professional, no
   * personal narrative, no credential claims we cannot stand behind.
   */
  bio: "He builds the Candid software that checks medical bills against EOBs, insurance plan documents, and the federal patient protection rules. These guides walk through the same checks, so you can run them yourself.",
  /**
   * Personal profiles for the Person entity. Deliberately EMPTY for now: the
   * LinkedIn page on file (linkedin.com/company/candidclaim) is the COMPANY,
   * and it already sits on the Organization's `sameAs`. Putting an
   * organization URL on a Person conflates two different entities and weakens
   * both. Add a personal profile URL here when there is one.
   */
  sameAs: [] as string[],
} as const;
