/**
 * citation-registry — S325 (PR-A, C2). ONE home for every statutory /
 * regulatory citation a letter may emit, each carrying the exact string, a
 * plain-English label, and the date it was last verified against a primary
 * source.
 *
 * THE CONTRACT (enforced by scripts/calibration/fixtures/legal/citation-registry.ts):
 * a citation-shaped string may appear in a letter-emitting module ONLY if the
 * exact text is covered by an entry here. Counsel-reviewed sentences keep
 * their citations inline (byte-exact prose is the point); this registry is
 * the citations-of-record list that proves each one was verified — and the
 * fixture is the sync guard that stops an unverified or wrong-form citation
 * (the S324 find: "ACA §2719" is not a real citation form — §2719 is a
 * Public Health Service Act section, 42 U.S.C. §300gg-19) from riding into
 * a letter again.
 *
 * Adding an entry = adding a verified citation: fill `verified` with the date
 * YOU checked the primary source, not the date you wrote the code.
 *
 * The per-state lever registry (`resolveStateCitation`) moved here from
 * templates.ts (S325) — same behavior, INERT until counsel-verified entries
 * land (tracker Item R; the S325 forum-menu plan §1f is its activation path).
 */

export interface CitationEntry {
  /** The exact citation text as letters emit it. */
  readonly cite: string;
  /** Plain-English label — what this citation actually provides. */
  readonly label: string;
  /** YYYY-MM-DD the citation form + substance were last verified. */
  readonly verified: string;
  /** Optional caveat (form quirks, scope limits). */
  readonly note?: string;
}

export const CITATION_REGISTRY: Record<string, CitationEntry> = {
  phsa_2719: {
    cite: "PHSA §2719 (42 U.S.C. §300gg-19)",
    label: "The ACA's appeals + external-review requirement (Public Health Service Act §2719).",
    verified: "2026-08-26",
    note: "The corrected form — never 'ACA §2719' (the ACA has no operative §2719; it added this section to the PHSA).",
  },
  phsa_2719_erisa: {
    cite: "PHSA §2719 (42 U.S.C. §300gg-19; applied to ERISA plans by 29 U.S.C. §1185d)",
    label: "The same requirement as incorporated for employer (ERISA) plans.",
    verified: "2026-08-26",
  },
  external_review_reg: {
    cite: "45 CFR §147.136",
    label: "The HHS regulation implementing internal claims/appeals + external review.",
    verified: "2026-08-26",
  },
  erisa_claims_reg: {
    cite: "29 CFR §2560.503-1",
    label: "The ERISA claims-procedure regulation (full and fair review).",
    verified: "2026-08-26",
  },
  erisa_claims_reg_g: {
    cite: "29 CFR §2560.503-1(g)",
    label: "Denial notices must cite the specific plan provision relied on.",
    verified: "2026-08-26",
  },
  erisa_claims_reg_h2iii: {
    cite: "29 CFR §2560.503-1(h)(2)(iii)",
    label: "Claimants get, free of charge, all documents relevant to the claim.",
    verified: "2026-08-26",
  },
  erisa_spd_production: {
    cite: "29 USC §1024(b)(4)",
    label: "The plan administrator must furnish the SPD/plan document on written request (30 days).",
    verified: "2026-08-26",
    note: "Emitted in the historical no-period 'USC' form; both forms are acceptable citation style.",
  },
  fdcpa_validation: {
    cite: "15 U.S.C. §1692g",
    label: "FDCPA debt-validation rights within 30 days of a collector's initial communication.",
    verified: "2026-08-26",
    note: "Third-party collectors only — Cal. Civ. Code §1788.17 carves original creditors out of §1692g (the S324 counsel find). The collections-track redesign (review doc §3.1) owns the recipient-side fix.",
  },
  fdcpa_validation_display: {
    cite: "FDCPA §1692g",
    label: "Compact display form of the validation citation (internal labels/deadline chips).",
    verified: "2026-08-26",
    note: "Display-surface shorthand only; letters emit the full 15 U.S.C. form.",
  },
  fdcpa_dispute_flag: {
    cite: "15 U.S.C. §1692e(8)",
    label: "A disputed debt must be reported as disputed to consumer reporting agencies.",
    verified: "2026-08-26",
  },
  nsa: {
    cite: "No Surprises Act (Public Law 116-260)",
    label: "Federal surprise-billing protections (emergency + certain in-network-facility care).",
    verified: "2026-08-26",
  },
  hipaa_right_of_access: {
    cite: "45 CFR §164.524",
    label: "The HIPAA right of access to one's own records (the itemized-records hook).",
    verified: "2026-08-26",
    note: "The corrected form — 'HIPAA Section 164.524' conflated the statute with its CFR regulation.",
  },
} as const;

/** Every registered exact citation string — the fixture's coverage universe. */
export const REGISTERED_CITES: readonly string[] = Object.values(CITATION_REGISTRY).map(
  (e) => e.cite,
);

// ---------------------------------------------------------------------------
// Per-state levers (moved verbatim from templates.ts, S325)
// ---------------------------------------------------------------------------

/** dispute-letters v2 S2 — state-specific citation registry. INERT at launch (no verified entries),
 *  so `resolveStateCitation` returns null for every (state, lever). Counsel-verified, per-entry
 *  activation is post-launch (map §10 / tracker Item R). */
const LEGAL_CITATION_REGISTRY: Record<string, string> = {}; // keyed `${state}:${lever}` — empty until verified

/** State-aware via profiles.state (planContext.userState); fail-closed to null (unverified state →
 *  federal levers + generic only, per map §5). */
export function resolveStateCitation(state: string | null | undefined, lever: string): string | null {
  if (!state) return null;
  return LEGAL_CITATION_REGISTRY[`${state}:${lever}`] ?? null;
}
