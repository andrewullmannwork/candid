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
  // ── S330 — the DFY paper stack's citations of record (handoff §2.3: any DFY
  // paper that cites law registers its cites). Verified against the counsel
  // corpus at plans/findings/counsel-review-2026-08-26/ (03_Authorized-
  // Representative_v2, 07_CMIA-Architecture-Research, 09_Engagement_v2 §Q2/Q10).
  erisa_claims_rep: {
    cite: "29 CFR §2560.503-1(b)(4)",
    label: "ERISA claims procedure — a claimant may act through an authorized representative (the plan may verify the designation).",
    verified: "2026-09-01",
    note: "Contains no natural-person limitation; the 2000 preamble (65 Fed. Reg. 70246) and the DOL 2019 information letter treat entity representatives as permitted — counsel Q2 confirms which name appears in which channel.",
  },
  hipaa_authorization: {
    cite: "45 CFR §164.508",
    label: "HIPAA — the core elements and required statements of a valid authorization to use or disclose protected health information.",
    verified: "2026-09-01",
  },
  cmia_authorization_form: {
    cite: "Cal. Civ. Code §56.11",
    label: "CMIA — the required form of an authorization to release medical information (separate instrument, 14-point type or handwritten, named parties, limits, expiration, revocation, copy).",
    verified: "2026-09-01",
  },
  part2_records: {
    cite: "42 CFR Part 2",
    label: "Confidentiality of substance-use-disorder patient records — a separate, Part 2-compliant consent is required before such records may be disclosed.",
    verified: "2026-09-01",
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
  // --- California (S325 PR-B — the forum menu's verified statutes) ---------
  ca_knox_keene: {
    cite: "Knox-Keene Health Care Service Plan Act of 1975, Health & Safety Code § 1340 et seq.",
    label: "The act under which the DMHC licenses most CA commercial plans (incl. most PPOs/EPOs).",
    verified: "2026-08-26",
  },
  ca_ins_code_imr: {
    cite: "California Insurance Code §§ 10169–10169.5",
    label: "CDI's Independent Medical Review program (binding on the insurer, free).",
    verified: "2026-08-26",
  },
  ca_fair_pricing_act: {
    cite: "Hospital Fair Pricing Act, Health & Safety Code §§ 127400–127446",
    label: "CA hospital charity-care/discount obligations (≤400% FPL; HCAI-administered).",
    verified: "2026-08-26",
  },
  ca_fair_pricing_no_deadline: {
    cite: "Health & Safety Code § 127405(e)(3)",
    label: "A hospital may not impose time limits on charity-care applications.",
    verified: "2026-08-26",
  },
  ca_ab2297: {
    cite: "AB 2297 (Ch. 511, Stats. 2024)",
    label: "No asset test for CA hospital financial assistance (eff. 2025-01-01).",
    verified: "2026-08-26",
    note: "The credit-reporting prohibition is SB 1061's — always cite BOTH (memo 04 flag 14).",
  },
  ca_sb1061: {
    cite: "SB 1061 (Ch. 520, Stats. 2024)",
    label: "No adverse credit reporting of CA hospital debt (eff. 2025-01-01).",
    verified: "2026-08-26",
  },
  ca_facility_licensing: {
    cite: "Health & Safety Code §1250 et seq.",
    label: "CA health-facility licensing (CDPH Licensing & Certification).",
    verified: "2026-08-26",
  },
  ca_rosenthal: {
    cite: "Rosenthal Fair Debt Collection Practices Act, Civ. Code §1788 et seq.",
    label: "CA debt-collection conduct rules — reach original creditors, EXCEPT §1692g validation (§1788.17 carve-back).",
    verified: "2026-08-26",
  },
  ca_dcla: {
    cite: "Debt Collection Licensing Act, Fin. Code §100000 et seq.",
    label: "CA debt-collector licensing (NMLS lookup is fact-finding, never an assertion).",
    verified: "2026-08-26",
  },
  // --- Washington ----------------------------------------------------------
  wa_external_review: {
    cite: "RCW 48.43.535(8)",
    label: "WA independent external review; carriers must pay the IRO and implement its determination.",
    verified: "2026-08-26",
    note: "Two live versions; the second takes effect 2027-01-01 — re-diff before then.",
  },
  wa_carrier_timelines: {
    cite: "RCW 48.43.530",
    label: "WA carrier grievance-process timelines (blown timelines excuse exhaustion).",
    verified: "2026-08-26",
  },
  wa_iro_notice_rule: {
    cite: "WAC 284-43-3150(5)",
    label: "The carrier's internal-determination notice must state the 180-day external-review window (a carrier-DISCLOSURE rule — phrase it as such).",
    verified: "2026-08-26",
  },
  wa_health_plan_def: {
    cite: "RCW 48.43.005",
    label: "WA 'health plan' definition — self-funded employer plans are excluded definitionally.",
    verified: "2026-08-26",
  },
  wa_bbpa_chapter: {
    cite: "chapter 48.49 RCW",
    label: "WA Balance Billing Protection Act (the chapter).",
    verified: "2026-08-26",
  },
  wa_bbpa_prohibition: {
    cite: "RCW 48.49.020(2)(c)",
    label: "The GENERAL balance-billing prohibition is .020(1); the enrollee refund (30 business days + 12%) is .020(2)(c).",
    verified: "2026-08-26",
    note: "NEVER cite .030 as the general rule (memo 04 §0.5 / flag 12 — behavioral-health only).",
  },
  wa_bbpa_bh: {
    cite: "RCW 48.49.030(1)(e)",
    label: "Behavioral-health emergency services ONLY: (1)(a) satisfies-obligation; (1)(e) provider refund duty.",
    verified: "2026-08-26",
  },
  wa_bbpa_optin: {
    cite: "RCW 48.49.130",
    label: "Self-funded plans reach the BBPA only by election (check the OIC list live).",
    verified: "2026-08-26",
  },
  wa_bbpa_ground: {
    cite: "RCW 48.49.200",
    label: "WA ground-ambulance balance billing — its OWN section, plans issued/renewed 2025+ (never cite .020 for ground ambulance).",
    verified: "2026-08-26",
  },
  wa_uda: {
    cite: "Uniform Disciplinary Act, chapter 18.130 RCW",
    label: "WA provider professional-conduct discipline (DOH HSQA).",
    verified: "2026-08-26",
  },
  wa_uda_refund: {
    cite: "RCW 18.130.160(11)",
    label: "A DOH fee refund exists only as a post-hearing disciplinary sanction — never a consumer remedy to request.",
    verified: "2026-08-26",
  },
  wa_cpa: {
    cite: "Consumer Protection Act, chapter 19.86 RCW; RCW 19.86.020",
    label: "WA unfair/deceptive practices prohibition (the AG's charity-care enforcement hook).",
    verified: "2026-08-26",
  },
  wa_cpa_enforcement: {
    cite: "RCW 19.86.080",
    label: "AG suit authority incl. restoration of money obtained by unlawful practices.",
    verified: "2026-08-26",
  },
  wa_charity_statute: {
    cite: "RCW 70.170.060(5)(c)(iii)(A)",
    label: "WA hospital charity care: tiers at (5); screening-precedes-collection at (10)(c); asset-info bar at (5)(c)(iv).",
    verified: "2026-08-26",
  },
  wa_charity_wac: {
    cite: "WAC 246-453-020",
    label: "WA charity-care procedure: collection precluded pending determination; 14-day processing; 30-day refunds.",
    verified: "2026-08-26",
  },
  wa_charity_penalties: {
    cite: "RCW 70.170.070",
    label: "WA charity-care penalties — pre-2018-renumbering text; the AG's CPA route is stronger for screening violations.",
    verified: "2026-08-26",
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
