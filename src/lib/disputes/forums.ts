/**
 * forums — S325 (PR-B, D4). The verified regulator/forum registry: ONE home
 * for every escalation forum the product may show or a letter may reference.
 *
 * PROVENANCE (the S325 merge ruling, [[s325-d4-forum-menu-build-plan]] §1a):
 *  - Routing spine + letterStrings: `forums-canonical.ts` (counsel corpus,
 *    post-adversarial-pass — the §0.5 RCW 48.49.030-vs-.020 correction and
 *    the behavioral-health string split live here). Letter strings are
 *    BYTE-EXACT from that file; do not reword without re-verification.
 *  - Product schema (menu labels/hints, contact, screening): `forums-draft-rich.ts`.
 *  - CA provider-conduct entries + the actionOnly wall: counsel memo
 *    `05_Counsel-Review_Forum-Menu_CA-Provider-Conduct_v1` (§B/§C/§F).
 *  - Fact conflicts between the two .ts sources: memos 04/05 are the tiebreaker.
 *
 * THE FOUR ROUTER INVARIANTS (memo 05 §F; fixture legal/forum-router.ts):
 *  1. No `provider_clinical_conduct` forum is selectable while composing a
 *     letter whose payload carries a disputed dollar amount.
 *  2. `actionOnly === true` ⟹ `letterString === null`, and the composer
 *     throws if such a forum reaches it (CRPC 3.10; Pen. Code §§518–519:
 *     threatening a licensing board or a criminal referral to obtain money is
 *     the prohibited shape — those forums are post-letter ACTIONS the user
 *     files themselves, never letter text).
 *  3. `cannot` holds VERBATIM agency language only; an empty array renders as
 *     "this agency publishes no jurisdictional limitation on billing
 *     disputes" — never synthesized text.
 *  4. The CA billing branch can return ZERO forums ("the bill is too high" has
 *     no California regulator) and the UI must render that honestly.
 *
 * CONDUCT LINE (review doc §3.4, ruling R14): routing consumes ONLY facts the
 * member supplies from their own documents (state, coverage type, the
 * regulator their own papers name). The eligible pool renders in a FIXED
 * role order, identical for every member with the same answers — no ranking,
 * no "recommended", no detection-driven featuring.
 *
 * VERIFIED_ON / RECHECK_BEFORE_RELEASE at the bottom are the staleness
 * contract; the operational calendar lives in the dispute-letters post-launch
 * tracker.
 */

// ---------------------------------------------------------------------------
// Screening facts (all member-supplied; persisted plan-level as
// insurance_plans.metadata.regulatory_classification — reusable by the DFY
// intake gates and the future parse enrichment, per the S325 plan §1b)
// ---------------------------------------------------------------------------

export type CoverageType =
  | "commercial_fully_insured" // employer or individual, insurer bears risk
  | "employer_self_funded" // ERISA self-funded / ASO
  | "employer_self_funded_public" // non-federal governmental or church plan
  | "medicare" // Original Medicare, Medicare Advantage, Part D
  | "medicaid" // Medi-Cal (CA) / Apple Health (WA)
  | "uninsured_self_pay";

export type CaRegulator = "DMHC" | "CDI" | "unknown";

/** The member's stored screening answers (plan-level fact, user-attested). */
export interface RegulatoryClassification {
  coverageType: CoverageType;
  /** CA fully-insured only. */
  caRegulator?: CaRegulator;
  /** WA self-funded only: plan appears on the OIC's BBPA opt-in list. */
  waBbpaOptedIn?: boolean;
  /** user_screening = the member's own answers; operator_intake = a DFY operator reading the member's documents at intake (S330). */
  source: "user_screening" | "operator_intake";
  answeredAt: string; // ISO
}

/**
 * The CA regulator question — three sourced document tests, cheapest first
 * (memo 04 §0.1). NEVER ask "HMO or PPO?": DMHC licenses most CA PPOs/EPOs
 * under Knox-Keene, so product name misroutes the majority of PPO enrollees.
 * `unknown → DMHC` because DMHC forwards misrouted complaints to CDI rather
 * than closing them; the reverse is not documented.
 */
export const CA_REGULATOR_PROMPT = {
  question: "Which agency does your plan name as its regulator?",
  help: [
    "Test 1 — Your denial or appeal letter. California plans name their regulator and its phone number in the notice.",
    'Test 2 — Your Summary of Benefits and Coverage, section "Your Grievance and Appeals Rights."',
    "Test 3 — Your Evidence of Coverage or plan booklet, in the complaints/appeals section.",
    'If none of these is to hand, choose "I am not sure." We will route to the DMHC, which forwards to the CDI if the plan turns out to be theirs.',
  ],
  options: [
    { value: "DMHC", label: "California Department of Managed Health Care (DMHC)" },
    { value: "CDI", label: "California Department of Insurance (CDI)" },
    { value: "unknown", label: "I am not sure" },
  ],
  fallback: "DMHC" as CaRegulator,
} as const;

export const COVERAGE_PROMPT = {
  question: "What kind of health coverage did you have on the date of service?",
  help: "This decides which agencies can help you at all. If it's wrong, the agency will close your file and tell you to start over somewhere else.",
  options: [
    {
      value: "commercial_fully_insured",
      label: "A plan I or my employer bought from an insurance company",
      hint: "Individual, marketplace, or an employer plan where the insurer pays the claims.",
    },
    {
      value: "employer_self_funded",
      label: "An employer plan where my employer pays the claims itself",
      hint: "The insurer's name is on the card but the employer funds it. Common at large employers. Check your benefits guide or ask HR — this is the single most consequential answer here.",
    },
    { value: "employer_self_funded_public", label: "A state, school, or public employee plan" },
    { value: "medicare", label: "Medicare (Original or Medicare Advantage)" },
    { value: "medicaid", label: "Medicaid (Medi-Cal in California; Apple Health in Washington)" },
    { value: "uninsured_self_pay", label: "I was uninsured or paying out of pocket" },
  ],
} as const;

export const WA_BBPA_PROMPT = {
  question:
    "Is your employer's plan on the Insurance Commissioner's list of self-funded plans that have elected into the Balance Billing Protection Act?",
  help:
    "Under RCW 48.49.130 a self-funded plan is covered by Washington's balance-billing law only if it elects in. The OIC publishes a searchable list. The list carries no 'last updated' date — check it live, never from memory.",
  listUrl:
    "https://www.insurance.wa.gov/insurers-regulated-entities/laws-and-rules-insurers-and-regulated-entities/protections-surprise-medical-billing/self-funded-group-health-plans-participating-balance-billing-protection-act",
} as const;

// ---------------------------------------------------------------------------
// What the dispute is about — narrowed from the letter's own track + the
// member's confirmation, never a detector.
// ---------------------------------------------------------------------------

export type DisputeKind =
  | "medical_necessity_denial" // denied/modified/delayed as not medically necessary
  | "experimental_denial" // denied as experimental or investigational
  | "claim_billing_dispute" // claim handling, cost-share, coverage, delay
  | "balance_bill" // out-of-network bill the member should not owe
  | "provider_clinical_conduct" // quality of care, professional conduct
  | "provider_billing_conduct" // services not rendered, deceptive billing, collections
  | "hospital_bill_affordability"; // charity care / financial assistance

// ---------------------------------------------------------------------------
// Forum shape
// ---------------------------------------------------------------------------

/** Fixed presentation order of roles — identical for everyone (R14). */
export const FORUM_ROLE_ORDER = [
  "internal_appeal",
  "external_review",
  "consumer_complaint",
  "statutory_right",
  "licensing_discipline",
  "law_enforcement",
  "federal_backstop",
] as const;

export type ForumRole = (typeof FORUM_ROLE_ORDER)[number];

export interface Forum {
  id: string;
  /** Exact legal name. Used verbatim in letters. Never abbreviate on first use. */
  agency: string;
  /** Short form for second and later references. */
  short: string;
  /** Named sub-unit or program, where the agency has one. */
  unit?: string;
  role: ForumRole;
  /** Door-tile label (the rail's picker). */
  menuLabel: string;
  /** One line under the label. */
  menuHint: string;
  /** What this forum can actually do. Shown in the picker. */
  handles: string;
  /**
   * What it cannot do — VERBATIM agency language only (invariant 3). Empty
   * array = the agency publishes no limitation; the UI says exactly that.
   */
  cannot: readonly string[];
  phone?: string;
  tdd?: string;
  email?: string;
  url: string;
  /** Deadline copy, phrased exactly as the source phrases it. */
  deadline?: string;
  /** Prerequisite the member must satisfy first (informational). */
  prerequisite?: string;
  cost?: string;
  binding?: string;
  authority?: string;
  /**
   * The sentence that may go into a letter. `null` + actionOnly = this forum
   * is a post-letter ACTION the member files themselves (invariant 2).
   */
  letterString: string | null;
  /** Narrower variant where the statute splits by service type. */
  letterStringBehavioralHealthEmergency?: string;
  /** true ⟹ never composable into any letter; link-out only. */
  actionOnly: boolean;
  /** Registry ids for every citation embedded in this entry's strings. */
  citationIds: readonly string[];
  sources: readonly string[];
}

// ===========================================================================
// CALIFORNIA — payer side
// ===========================================================================

export const CA_FORUMS: Record<string, Forum> = {
  ca_dmhc_imr: {
    id: "ca_dmhc_imr",
    agency: "California Department of Managed Health Care",
    short: "DMHC",
    unit: "DMHC Help Center — Independent Medical Review",
    role: "external_review",
    menuLabel: "Apply for an Independent Medical Review — DMHC",
    menuHint:
      "For a denial based on medical necessity, experimental/investigational status, or emergency care. Free. Binding on the plan.",
    handles:
      "A denial, modification, or delay of a requested service on medical-necessity grounds; a denial of payment for emergency treatment; or a denial of experimental or investigational treatment.",
    cannot: [
      "Does not decide plain billing or cost-share disputes — those go to the Consumer Complaint track.",
    ],
    phone: "1-888-466-2219",
    tdd: "1-877-688-9891",
    url: "https://www.dmhc.ca.gov/FileaComplaint.aspx",
    deadline:
      "Apply within six months after the health plan sends its written response to the appeal.",
    prerequisite:
      "Complete the plan's grievance process, or participate in it for 30 days. Not required if the denial was experimental or investigational; immediate assistance is available if there is a serious threat to life.",
    cost: 'Free. "The IMR/Complaint process is free."',
    binding: "Health plans must follow the IMR decision and promptly provide the service.",
    authority: "Knox-Keene Health Care Service Plan Act of 1975, Health & Safety Code § 1340 et seq.",
    letterString:
      "If this determination is not reversed, I will apply for an Independent Medical Review with the California Department of Managed Health Care Help Center (1-888-466-2219; TDD 1-877-688-9891), which regulates this plan under the Knox-Keene Health Care Service Plan Act. An IMR decision in my favor is binding on the plan and costs me nothing.",
    actionOnly: false,
    citationIds: ["ca_knox_keene"],
    sources: [
      "https://www.dmhc.ca.gov/FileaComplaint.aspx",
      "https://www.dmhc.ca.gov/Portals/0/Docs/HC/AccessibleIMRFormEnglish.pdf",
      "https://www.dmhc.ca.gov/FileaComplaint/IndependentMedicalReviewComplaintProcess.aspx",
    ],
  },

  ca_dmhc_complaint: {
    id: "ca_dmhc_complaint",
    agency: "California Department of Managed Health Care",
    short: "DMHC",
    unit: "DMHC Help Center — Consumer Complaint",
    role: "consumer_complaint",
    menuLabel: "File a complaint with the DMHC Help Center",
    menuHint:
      "For billing problems, surprise bills, cancellations, copay disputes, network and access problems.",
    handles:
      "Billing problems, cancellation of coverage, claim and copay disputes, delays in getting an appointment, referral or authorization, access to translation services, finding an in-network doctor, hospital, or specialist, complaints about a doctor or plan, and continuity of care.",
    cannot: [],
    phone: "1-888-466-2219",
    tdd: "1-877-688-9891",
    url: "https://www.dmhc.ca.gov/FileaComplaint.aspx",
    deadline: "None published. Complaints are generally determined within 30 days of receipt.",
    prerequisite:
      "File a grievance on each issue with the plan and participate in its grievance process for 30 days first. Immediate assistance is available if there is a serious threat to life, or where the plan denied the request as experimental or investigational.",
    cost: "Free.",
    authority: "Knox-Keene Health Care Service Plan Act of 1975, Health & Safety Code § 1340 et seq.",
    letterString:
      "If this is not resolved, I will file a Consumer Complaint with the California Department of Managed Health Care Help Center (1-888-466-2219; TDD 1-877-688-9891), which regulates this plan under the Knox-Keene Health Care Service Plan Act and accepts complaints about billing and claim disputes.",
    actionOnly: false,
    citationIds: ["ca_knox_keene"],
    sources: [
      "https://www.dmhc.ca.gov/FileaComplaint.aspx",
      "https://www.dmhc.ca.gov/FileaComplaint/IndependentMedicalReviewComplaintProcess.aspx",
    ],
  },

  ca_cdi_imr: {
    id: "ca_cdi_imr",
    agency: "California Department of Insurance",
    short: "CDI",
    unit: "Independent Medical Review Program",
    role: "external_review",
    menuLabel: "Apply for an Independent Medical Review — CDI",
    menuHint:
      "The same remedy, different agency and different deadlines, for policies the CDI licenses.",
    handles:
      "Health care services denied, modified, or delayed where the decision rested wholly or partly on a finding that the service was not medically necessary, or was experimental or investigational; also a denial of a claim for urgent or emergency services.",
    cannot: [],
    phone: "1-800-927-4357",
    url: "https://www.insurance.ca.gov/01-consumers/110-health/60-resources/01-imr/",
    deadline:
      "Request within 6 months of the insurance company upholding its decision in the appeal or grievance process.",
    prerequisite:
      "File an appeal or grievance with the insurer first. If the insurer upholds its decision or has not ruled within 30 days of the appeal, the IMR request may be filed. CDI may waive the appeal requirement 'when an extraordinary or compelling case exists.'",
    cost: 'Free. "The cost of the IMR is paid completely by your insurance company."',
    binding: "The recommendation is binding on the insurance company.",
    authority: "California Insurance Code §§ 10169–10169.5",
    letterString:
      "If this determination is not reversed, I will request an Independent Medical Review from the California Department of Insurance (1-800-927-4357) under Insurance Code section 10169. The reviewers' decision is binding on the insurer and costs me nothing.",
    actionOnly: false,
    citationIds: ["ca_ins_code_imr"],
    sources: [
      "https://www.insurance.ca.gov/01-consumers/110-health/60-resources/01-imr/",
      "https://www.insurance.ca.gov/01-consumers/101-help/upload/IMR.pdf",
      "https://www.insurance.ca.gov/01-consumers/101-help/upload/ConsumerAdvisoryIMR.pdf",
    ],
  },

  ca_cdi_complaint: {
    id: "ca_cdi_complaint",
    agency: "California Department of Insurance",
    short: "CDI",
    unit: "Health Request for Assistance (HRFA)",
    role: "consumer_complaint",
    menuLabel: "File a Health Request for Assistance with the CDI",
    menuHint: "Complaint against a CDI-licensed health insurer over claim handling, coverage, or billing.",
    handles:
      "Complaints against health insurers CDI regulates — claim handling, coverage, and billing disputes.",
    cannot: [
      "Does not regulate HMOs, many PPOs, self-insured plans, or Medicare/Medi-Cal coverage.",
    ],
    phone: "1-800-927-4357",
    url: "https://www.insurance.ca.gov/01-consumers/110-health/50-h-rfa/",
    cost: "Free.",
    letterString:
      "If this is not resolved, I will file a Health Request for Assistance with the California Department of Insurance (1-800-927-4357), which regulates this policy.",
    actionOnly: false,
    citationIds: [],
    sources: [
      "https://www.insurance.ca.gov/01-consumers/110-health/50-h-rfa/",
      "https://www.insurance.ca.gov/01-consumers/110-health/10-basics/health-ins-reg.cfm",
    ],
  },

  /**
   * Eligibility: self-pay OR high medical costs, AND family income <= 400% FPL.
   * "High medical costs" has THREE prongs, not one — the route by which
   * INSURED members qualify (memo 04 §1.6). Letter interpolation slots
   * (`${selfPayOrHighCost}`) are literal placeholders the composer fills.
   */
  ca_hcai_charity_care: {
    id: "ca_hcai_charity_care",
    agency: "California Department of Health Care Access and Information",
    short: "HCAI",
    unit: "Hospital Fair Billing Program — Hospital Bill Complaint Program",
    role: "statutory_right",
    menuLabel: "Apply for charity care / a discount under the Hospital Fair Pricing Act",
    menuHint:
      "California hospital bills: free or discounted care at ≤400% FPL — no application deadline, no asset test, and insured patients qualify through the high-medical-costs prong.",
    handles:
      "Enforcement of the Hospital Fair Pricing Act against hospitals: failure to give notice of the policy, failure to offer an application, applying an asset test, imposing an application deadline, adverse credit reporting, or placing a lien.",
    cannot: [
      'The Hospital Bill Complaint Program does not have jurisdiction (authority) over general billing and fee disputes, price transparency, Good Faith Estimates, or billing by an emergency room provider (other than facility charges).',
    ],
    url: "https://hcai.ca.gov/affordability/hospital-fair-billing-program/hospital-bill-complaint-program/",
    deadline:
      "None — and this is the point. A hospital may not impose time limits for applying for charity care or discounted payments, nor deny eligibility based on the timing of the application (Health & Safety Code § 127405(e)(3)).",
    authority: "Hospital Fair Pricing Act, Health & Safety Code §§ 127400–127446",
    letterString:
      "Under the Hospital Fair Pricing Act, Health & Safety Code sections 127400 through 127446, I am applying for charity care or a discount payment. I am ${selfPayOrHighCost} with family income of not more than 400 percent of the federal poverty level. Health & Safety Code section 127405(e)(3) provides that a hospital shall not impose time limits for applying for charity care or discounted payments, nor deny eligibility based on the timing of a patient's application. Effective January 1, 2025, under AB 2297 (Ch. 511, Stats. 2024) and SB 1061 (Ch. 520, Stats. 2024), monetary assets may no longer be considered in determining eligibility, and adverse information about hospital debt may not be reported to a consumer credit reporting agency. Please send me your filed policy, the plain-language summary, and the application form, and suspend collection activity while my application is pending.",
    actionOnly: false,
    citationIds: ["ca_fair_pricing_act", "ca_fair_pricing_no_deadline", "ca_ab2297", "ca_sb1061"],
    sources: [
      "https://hcai.ca.gov/affordability/hospital-fair-billing-program/hospital-bill-complaint-program/frequently-asked-questions/",
      "https://hcai.ca.gov/wp-content/uploads/2025/11/PIL-24-03.pdf",
      "https://hcai.ca.gov/affordability/hospital-fair-billing-program/hospital-fair-pricing-policy-lookup/",
      "https://oag.ca.gov/system/files/attachments/press-docs/Charity%20Care%20-%20Patient%20FAQ%20Bulletin%20(2).pdf",
    ],
  },
};

// ===========================================================================
// CALIFORNIA — provider-conduct side (memo 05; ALL clinical entries actionOnly)
// ===========================================================================

/** Route a clinical-conduct complaint by WHO, not what (memo 05 §1a). */
export const CA_CLINICAL_BY_LICENSE: Record<string, string> = {
  MD: "ca_mbc",
  DO: "ca_ombc",
  PA: "ca_pab",
  RN: "ca_brn",
  NP: "ca_brn",
  LVN: "ca_bvnpt",
  DDS: "ca_dbc",
  DMD: "ca_dbc",
  RDA: "ca_dbc",
  PT: "ca_ptbc",
  PTA: "ca_ptbc",
  PSYD: "ca_psychology",
  PHD_PSY: "ca_psychology",
  LMFT: "ca_bbs",
  LCSW: "ca_bbs",
  LPCC: "ca_bbs",
  DC: "ca_bce",
  OD: "ca_optometry",
  RPH: "ca_pharmacy",
  DPM: "ca_pmbc",
  LAC: "ca_acupuncture",
  RCP: "ca_rcb",
  SLP: "ca_slpahadb",
  AUD: "ca_slpahadb",
  FACILITY: "ca_cdph_lc",
};

/** Shared builder for the compact DCA-board entries (memo 05 §B-4). */
function dcaBoard(
  id: string,
  agency: string,
  short: string,
  url: string,
  phone: string,
  cannot: readonly string[],
  handles: string,
): Forum {
  return {
    id,
    agency,
    short,
    role: "licensing_discipline",
    menuLabel: `File a licensing complaint — ${short}`,
    menuHint: "About the care or conduct — never the bill.",
    handles,
    cannot,
    phone,
    url,
    letterString: null,
    actionOnly: true,
    citationIds: [],
    sources: [url],
  };
}

export const CA_PROVIDER_CONDUCT_FORUMS: Record<string, Forum> = {
  ca_mbc: {
    id: "ca_mbc",
    agency: "Medical Board of California",
    short: "MBC",
    unit: "Central Complaint Unit",
    role: "licensing_discipline",
    menuLabel: "File a licensing complaint — Medical Board of California (M.D.s)",
    menuHint: "Quality of care, prescribing, records, impairment. Not billing.",
    handles:
      'Quality of Care (Misdiagnosis, treatment/medication causing side effects, surgical complications, negligent care, etc.); Office Practice (Failure to sign death certificate, failure to provide records, misleading advertising); Inappropriate Prescribing; Provider Impairment; Sexual Misconduct; Unlicensed Activity.',
    cannot: [
      "The Board does not have jurisdiction over billing/fee disputes, general business practices (contracts, office policies, appointment times/duration, etc.) or personal conflicts, unless the behavior in question interferes with the safe delivery of health care.",
      "The Board cannot assist with any coordination of patient care or provide financial compensation.",
      "The Board also has no authority over a medical provider's attitude, bedside manner, demeanor, or office staff or prices charged or refund disputes with a medical provider unless there is a double payment by the insurance company.",
    ],
    phone: "1-800-633-2322",
    url: "https://www.mbc.ca.gov/Consumers/file-a-complaint/",
    authority: "B&P Code Div. 2, Ch. 5 (Medical Practice Act)",
    letterString: null,
    actionOnly: true,
    citationIds: [],
    sources: [
      "https://www.mbc.ca.gov/Consumers/Complaints/",
      "https://www.mbc.ca.gov/Consumers/file-a-complaint/",
      "https://www.mbc.ca.gov/Resources/brochures/Complaints.aspx",
    ],
  },
  ca_ombc: {
    id: "ca_ombc",
    agency: "Osteopathic Medical Board of California",
    short: "OMBC",
    unit: "Enforcement Unit",
    role: "licensing_discipline",
    menuLabel: "File a licensing complaint — Osteopathic Medical Board (D.O.s)",
    menuHint: "D.O.s are NOT the Medical Board's jurisdiction — this is their board.",
    handles: "Professional-conduct and quality-of-care complaints against D.O.s.",
    cannot: [
      "No jurisdiction over M.D.'s licensed by the Medical Board of California, chiropractors, dentists, health maintenance organizations, hospitals, insurance companies, malpractice actions/civil lawsuits.",
      "Cannot address prices charged or refund disputes with a medical provider unless there is a double payment by the insurance company.",
    ],
    phone: "(916) 928-8390 ext. 6",
    email: "Osteoenforcement@dca.ca.gov",
    url: "https://www.ombc.ca.gov/consumer_complaint/file_a_complaint.shtml",
    letterString: null,
    actionOnly: true,
    citationIds: [],
    sources: ["https://www.ombc.ca.gov/forms_pubs/a_consumers_guide_to_the_complaint_process.pdf"],
  },
  ca_cdph_lc: {
    id: "ca_cdph_lc",
    agency: "California Department of Public Health, Center for Health Care Quality",
    short: "CDPH L&C",
    unit: "Licensing and Certification Program",
    role: "licensing_discipline",
    menuLabel: "File a facility complaint — CDPH Licensing & Certification",
    menuHint: "Hospitals, skilled nursing, clinics, home health, hospice — facility-level care and conditions.",
    handles:
      "A facility's alleged noncompliance with state and/or federal laws and regulations. Anyone can file a complaint against a health-care facility — a patient or facility resident, a relative or friend, even a general member of the public.",
    cannot: [
      "CDPH does not license medical doctors (MDs), registered nurses (RNs) or vocational nurses (LVNs).",
      "CDPH does not regulate assisted living facilities or other non-medical residential facilities.",
    ],
    phone: "(800) 236-9747",
    url: "https://www.cdph.ca.gov/Programs/CHCQ/LCP/Pages/FileAComplaint.aspx",
    authority: "H&S Code Div. 2, Ch. 2 (§1250 et seq.) — facility licensing",
    letterString: null,
    actionOnly: true,
    citationIds: [],
    sources: [
      "https://www.cdph.ca.gov/Programs/CHCQ/LCP/Pages/FileAComplaint.aspx",
      "https://www.cdph.ca.gov/Programs/CHCQ/LCP/CalHealthFind/Pages/ComplaintInvestigationProcess.aspx",
    ],
  },
  ca_brn: dcaBoard(
    "ca_brn",
    "Board of Registered Nursing",
    "BRN",
    "https://www.rn.ca.gov/enforcement/filecomplaint.shtml",
    "(916) 557-1213",
    [
      'Outside Board authority: "fee/billing disputes", "general business practices", "personality conflicts", and providers licensed by other boards/bureaus.',
    ],
    "RNs, applicants, and individuals who hold themselves out to the public as RNs.",
  ),
  ca_pab: dcaBoard(
    "ca_pab",
    "Physician Assistant Board",
    "PAB",
    "https://www.pab.ca.gov/consumers/complaints.shtml",
    "(916) 576-2676",
    [
      "The Board does not have jurisdiction over billing/fee disputes, general business practices … or personal conflicts, unless the behavior in question interferes with the safe delivery of health care.",
      "Please be advised that the Board cannot assist with any coordination of patient care or provide financial compensation.",
    ],
    "Physician assistants.",
  ),
  ca_dbc: dcaBoard(
    "ca_dbc",
    "Dental Board of California",
    "DBC",
    "https://www.dbc.ca.gov/consumers/complaints.shtml",
    "(877) 729-7789",
    [
      "Beyond Board authority: General (administrative) office procedures of the dental office. Fee and billing disputes. Insurance coverage disputes. Reimbursements or financial compensation. Rude behavior by dentists and dental staff.",
    ],
    "Dentists, RDAs, RDAEFs, permit holders.",
  ),
  ca_ptbc: dcaBoard(
    "ca_ptbc",
    "Physical Therapy Board of California",
    "PTBC",
    "https://www.ptbc.ca.gov/consumers/complaint/complaint_process.shtml",
    "(800) 832-2251",
    [
      "PTBC does not have jurisdiction over billing/fee disputes, general business practices … or personal conflicts, unless the behavior in question interferes with the safe delivery of health care.",
      "PTBC cannot assist with any coordination of patient care or provide financial compensation.",
    ],
    "PTs, PTAs, aides, unlicensed practice.",
  ),
  ca_psychology: dcaBoard(
    "ca_psychology",
    "California Board of Psychology",
    "Board of Psychology",
    "https://www.psychology.ca.gov/consumers/filecomplaint.shtml",
    "(866) 503-3221",
    [
      "The Board has no authority over fee or billing disputes, general business practices, personality conflicts, or persons who are licensed by other boards.",
    ],
    "Psychologists, psychological associates, testing technicians.",
  ),
  ca_bce: dcaBoard(
    "ca_bce",
    "California Board of Chiropractic Examiners",
    "BCE",
    "https://www.chiro.ca.gov/consumers/complaint.shtml",
    "(866) 543-1311",
    ["The Board does not have jurisdiction in fee or billing disputes, general business practices, and personality conflicts."],
    "Chiropractors.",
  ),
  ca_optometry: dcaBoard(
    "ca_optometry",
    "California State Board of Optometry",
    "Board of Optometry",
    "https://www.optometry.ca.gov/formspubs/complaints.shtml",
    "(866) 585-2666",
    [
      "The Board has no statutory authority to set or modify fees charged by licensed optometrists or to compel refunds, so complaints with unresolved fee disputes may be referred to Small Claims Court.",
    ],
    "ODs and dispensing registrants.",
  ),
  ca_pharmacy: dcaBoard(
    "ca_pharmacy",
    "California State Board of Pharmacy",
    "Board of Pharmacy",
    "https://www.pharmacy.ca.gov/consumers/complaint_info.shtml",
    "(916) 518-3100",
    [
      "The Board generally does not have jurisdiction over complaints that pertain solely to customer service or billing issues.",
      "The board does not have jurisdiction over drug prices charged by the pharmacy or prescription billing disputes with insurance carriers.",
    ],
    "Pharmacists, technicians, pharmacies, wholesalers.",
  ),
  ca_slpahadb: dcaBoard(
    "ca_slpahadb",
    "Speech-Language Pathology and Audiology and Hearing Aid Dispensers Board",
    "SLPAHADB",
    "https://www.speechandhearing.ca.gov/enforcement/complaint_process.html",
    "(916) 287-7915",
    [
      "Allegations that are not within SLPAHADB's authority include: Fee or billing disputes; General business practices; Personality conflicts. Fee and billing disputes may be handled through an attorney or small claims court.",
    ],
    "SLPs, audiologists, hearing aid dispensers.",
  ),
  ca_acupuncture: dcaBoard(
    "ca_acupuncture",
    "California Acupuncture Board",
    "Acupuncture Board",
    "https://www.acupuncture.ca.gov/consumers/file_complaint.shtml",
    "(916) 515-5200",
    [
      "Complaints that are clearly nonjurisdictional (i.e., fee disputes, insurance issues) are referred to other agencies or organizations which may be more able to assist the complainant.",
    ],
    "Licensed acupuncturists.",
  ),
  // The four boards below publish NO fee/billing limitation — the UI renders
  // the honest sentence, never synthesized text (invariant 3).
  ca_bvnpt: dcaBoard(
    "ca_bvnpt",
    "California Board of Vocational Nursing and Psychiatric Technicians",
    "BVNPT",
    "https://www.bvnpt.ca.gov/enforcement/file_a_complaint.shtml",
    "(916) 263-7827",
    [],
    "LVNs, psychiatric technicians.",
  ),
  ca_bbs: dcaBoard(
    "ca_bbs",
    "Board of Behavioral Sciences",
    "BBS",
    "https://www.bbs.ca.gov/consumers/consumer_complaints.html",
    "(916) 574-7830",
    [],
    "LMFT, LCSW, LEP, LPCC and associates.",
  ),
  ca_pmbc: dcaBoard(
    "ca_pmbc",
    "Podiatric Medical Board of California",
    "PMBC",
    "https://www.pmbc.ca.gov/consumers/complaints.html",
    "(800) 633-2322",
    [],
    "DPMs, residents.",
  ),
  ca_rcb: dcaBoard(
    "ca_rcb",
    "Respiratory Care Board of California",
    "RCB",
    "https://www.rcb.ca.gov/consumers/cons_file_a_complaint.shtml",
    "(916) 999-2190",
    [],
    "Respiratory care practitioners.",
  ),
};

// ===========================================================================
// CALIFORNIA — billing-conduct side (memo 05 §C)
// ===========================================================================

export const CA_BILLING_CONDUCT_FORUMS: Record<string, Forum> = {
  ca_ag_piu: {
    id: "ca_ag_piu",
    agency: "Office of the Attorney General, California Department of Justice",
    short: "CA AG",
    unit: "Public Inquiry Unit",
    role: "law_enforcement",
    menuLabel: "File a consumer complaint — California Attorney General",
    menuHint: "Deceptive or unfair billing PRACTICES (a pattern, not one bill). Builds the enforcement record.",
    handles:
      "Complaints are used by the Attorney General's Office to learn about misconduct and to determine whether to investigate a company.",
    cannot: [
      "The Attorney General cannot answer legal questions or give legal advice to me and cannot act as my personal lawyer.",
      "This office does not have the authority to give private legal advice or provide private legal representation to individual consumers.",
      "The Attorney General may need to refer my complaint to a more appropriate agency.",
    ],
    phone: "(800) 952-5225",
    url: "https://oag.ca.gov/contact/consumer-complaint-against-business-or-company",
    letterString:
      "If this billing is not corrected, I will file a consumer complaint with the California Attorney General's Public Inquiry Unit describing this billing practice.",
    actionOnly: false,
    citationIds: [],
    sources: [
      "https://oag.ca.gov/contact/consumer-complaint-against-business-or-company",
      "https://oag.ca.gov/contact",
      "https://oag.ca.gov/consumers",
    ],
  },
  ca_dfpi: {
    id: "ca_dfpi",
    agency: "California Department of Financial Protection and Innovation",
    short: "DFPI",
    unit: "Consumer Services Office",
    role: "consumer_complaint",
    menuLabel: "Report a debt collector — DFPI",
    menuHint:
      "Third-party collection agencies on medical debt: licensing (DCLA) + conduct (Rosenthal Act).",
    handles:
      "Licenses debt collectors and debt buyers under the Debt Collection Licensing Act; takes consumer complaints about them; enforces the CCFPL.",
    cannot: [
      "The Department cannot give you legal advice so please consult a private attorney if money needs to be recovered or a contract needs to be cancelled.",
      "CSO does not act as an advocate for individual consumers or financial service providers.",
      "CSO does not possess the statutory authority to award damages, overturn decisions, or impose other charges or penalties.",
    ],
    phone: "(866) 275-2677",
    url: "https://dfpi.ca.gov/submit-a-complaint/",
    authority:
      "Debt Collection Licensing Act, Fin. Code §100000 et seq.; Rosenthal Fair Debt Collection Practices Act, Civ. Code §1788 et seq.",
    // THIRD-PARTY COLLECTORS ONLY (memo 05 §C-4 design constraints): the NMLS
    // license check is a FACT-FINDING step, never an assertion — a provider
    // collecting its own bill is exempt from §1692g via Civ. Code §1788.17's
    // carve-back, and probably from DCLA licensure (draft reg §1850.1(e)).
    letterString:
      "Your collection of this account is subject to the Rosenthal Fair Debt Collection Practices Act (California Civil Code section 1788 et seq.). If this account is not corrected, I will file a complaint with the California Department of Financial Protection and Innovation and verify your Debt Collection Licensing Act license status through NMLS Consumer Access.",
    actionOnly: false,
    citationIds: ["ca_rosenthal", "ca_dcla"],
    sources: [
      "https://dfpi.ca.gov/wp-content/uploads/sites/337/forms/bank/DFPI-801.pdf",
      "https://dfpi.ca.gov/debt-collection-licensee/",
      "https://solid.dca.ca.gov/publications/newsletter/winter2018.shtml",
    ],
  },
  ca_da_consumer: {
    id: "ca_da_consumer",
    agency: "Office of the District Attorney (your county)",
    short: "County DA",
    unit: "Consumer Protection Unit",
    role: "law_enforcement",
    menuLabel: "Report to your county District Attorney's consumer unit",
    menuHint:
      "A criminal prosecutor's consumer unit. File it yourself — naming a prosecutor in a demand letter is the extortion shape.",
    handles:
      "Investigates and evaluates reports of fraudulent and unfair business practices and determines appropriate action.",
    cannot: [
      "Our office is prohibited from representing private citizens in individual disputes with other persons or businesses.",
      "We cannot provide legal advice or handle private legal matters.",
    ],
    url: "https://www.sdcda.org/preventing/consumer-protection/",
    letterString: null,
    actionOnly: true,
    citationIds: [],
    sources: [
      "https://www.sdcda.org/preventing/consumer-protection/",
      "https://www.sacda.org/in-the-courtroom/consumer-environmental-protection/consumer-unit/",
    ],
  },
  ca_cdi_fraud: {
    id: "ca_cdi_fraud",
    agency: "California Department of Insurance",
    short: "CDI Fraud Division",
    unit: "Fraud Division (Disability and Healthcare Fraud program)",
    role: "law_enforcement",
    menuLabel: "Report suspected insurance fraud — CDI Fraud Division",
    menuHint:
      "Charging for services not rendered / inflating claims to an insurer. May be filed anonymously.",
    handles:
      "Professionals and technicians who inflate the cost of services or charge for services not rendered. Notification of insurance fraud may be made anonymously by members of the general public.",
    cannot: [
      "The CDI does not regulate Health Maintenance Organizations (HMOs) or certain PPOs, which fall under the Knox-Keene Act.",
      "The California Department of Insurance does not regulate self-insured health plans, even in cases where the plan is administered by a health insurance company.",
    ],
    phone: "1-800-927-4357",
    url: "https://www.insurance.ca.gov/0300-fraud/0350-fraud-claims-and-forms/",
    letterString: null,
    actionOnly: true,
    citationIds: [],
    sources: [
      "https://www.insurance.ca.gov/0300-fraud/0100-fraud-division-overview/",
      "https://www.insurance.ca.gov/0300-fraud/reportingfraud.cfm",
    ],
  },
  ca_dhcs_fraud: {
    id: "ca_dhcs_fraud",
    agency: "California Department of Health Care Services",
    short: "DHCS",
    unit: "Audits & Investigations — Investigations Division",
    role: "law_enforcement",
    menuLabel: "Report Medi-Cal provider fraud — DHCS",
    menuHint: "Medi-Cal billing fraud, incl. balance-billing members beyond Medi-Cal rates. Anonymous OK.",
    handles:
      "Fraud occurs when providers misrepresent information or engage in dishonest practices to obtain payments they are not entitled to — including charging Medi-Cal for care that was never provided and charging members for amounts beyond Medi-Cal's reimbursement rate.",
    cannot: [
      "I understand that the Department of Health Care Services does not represent private citizens seeking private remedies.",
    ],
    phone: "(800) 822-6222",
    email: "fraud@dhcs.ca.gov",
    url: "https://www.dhcs.ca.gov/individuals/do-you-suspect-medi-cal-fraud-report-it/",
    letterString: null,
    actionOnly: true,
    citationIds: [],
    sources: ["https://www.dhcs.ca.gov/individuals/what-is-fraud/"],
  },
  // DMFEA: link-out with a USER-AUTHORED narrative ONLY — its reporting page
  // expressly "strongly discourages use of artificial intelligence (AI)
  // software to compose your complaint." Candid must never compose this one.
  ca_dmfea: {
    id: "ca_dmfea",
    agency: "California Department of Justice",
    short: "DMFEA",
    unit: "Division of Medi-Cal Fraud & Elder Abuse",
    role: "law_enforcement",
    menuLabel: "Report Medi-Cal fraud / elder abuse — DOJ DMFEA",
    menuHint:
      "Write this one in your own words — the Division strongly discourages AI-composed complaints. You file it yourself.",
    handles:
      "Suspected fraud by a Medi-Cal provider (doctor, dentist, pharmacist, IHSS caregiver, durable medical equipment supplier, lab, etc.); questionable billing, unnecessary services, misuse of benefits, physical, emotional or financial harm, theft.",
    cannot: [
      "The Office of the Attorney General is prohibited by law from representing private individuals.",
    ],
    phone: "(800) 722-0432",
    url: "https://oag.ca.gov/dmfea/reporting",
    letterString: null,
    actionOnly: true,
    citationIds: [],
    sources: ["https://oag.ca.gov/dmfea", "https://oag.ca.gov/dmfea/reporting"],
  },
};

// ===========================================================================
// WASHINGTON
// ===========================================================================

export const WA_FORUMS: Record<string, Forum> = {
  wa_oic_external_review: {
    id: "wa_oic_external_review",
    agency: "Washington State Office of the Insurance Commissioner",
    short: "OIC",
    unit: "Independent review by a certified independent review organization (IRO)",
    role: "external_review",
    menuLabel: "Request independent external review (IRO)",
    menuHint: "A reviewer outside your carrier decides. The carrier pays for it and must implement the decision.",
    handles:
      "A carrier's decision to deny, modify, reduce, or terminate coverage of or payment for a health care service.",
    cannot: [],
    phone: "800-562-6900",
    url: "https://www.insurance.wa.gov/complaints-appeals-fraud/appeals",
    deadline:
      'Up to 180 days to file a request for external review after the internal review decision. Cite carefully: WAC 284-43-3150 is a carrier-disclosure rule — subsection (5) requires the carrier to state "that the appellant has up to one hundred eighty days to file a request for external review."',
    prerequisite:
      "Exhaust the carrier's grievance process and receive an unfavorable decision — or the carrier exceeded the RCW 48.43.530 timelines without good cause and without reaching a decision, in which case exhaustion is excused.",
    cost: "None. The carrier must pay the certified independent review organization's charges.",
    binding: "Carriers must timely implement the IRO's determination (RCW 48.43.535(8)).",
    authority:
      "RCW 48.43.535; chapter 284-43A WAC. The Commissioner assigns the IRO from a rotational registry; the carrier may not choose it.",
    letterString:
      "If this denial stands after internal appeal, I will request independent review under RCW 48.43.535. The independent review organization is assigned by the Insurance Commissioner from a rotational registry, its determination is binding on the carrier, and the carrier bears its cost.",
    actionOnly: false,
    citationIds: ["wa_external_review", "wa_carrier_timelines", "wa_iro_notice_rule"],
    sources: [
      "https://app.leg.wa.gov/RCW/default.aspx?cite=48.43.535",
      "https://app.leg.wa.gov/wac/default.aspx?cite=284-43-3150",
      "https://www.insurance.wa.gov/insurance-resources/health-insurance/appealing-health-insurance-denial/how-appeal-health-insurance-denial",
    ],
  },

  wa_oic_complaint: {
    id: "wa_oic_complaint",
    agency: "Washington State Office of the Insurance Commissioner",
    short: "OIC",
    unit: "Consumer Advocacy",
    role: "consumer_complaint",
    menuLabel: "File a complaint with the Insurance Commissioner",
    menuHint: "The OIC requires your carrier to respond and reviews the response for compliance with law.",
    handles:
      "A belief that an insurer or agent has violated the law or treated you or your claim unfairly. The OIC can send the complaint to the company and require an explanation, review the response for compliance, and request that a company fix a problem if it did not follow the law.",
    cannot: [
      "Cannot establish the facts of a claim, determine values or fault, cause of loss or amount owed.",
      "Cannot make medical judgments or determine if a treatment is necessary.",
      "Cannot act as your lawyer or give legal advice.",
    ],
    phone: "800-562-6900",
    url: "https://www.insurance.wa.gov/file-complaint-or-check-your-complaint-status",
    prerequisite:
      "None. An appeal and a complaint run independently — the OIC states you can do both at the same time without them affecting each other.",
    cost: "Free.",
    letterString:
      "If this is not resolved, I will file a complaint with the Washington State Office of the Insurance Commissioner (800-562-6900), which regulates this plan. Filing that complaint does not pause or replace my appeal, and I am pursuing both.",
    actionOnly: false,
    citationIds: [],
    sources: [
      "https://www.insurance.wa.gov/complaints-appeals-fraud/complaints/how-we-can-help-you-your-complaint",
      "https://www.insurance.wa.gov/complaints-appeals-fraud/appeals",
    ],
  },

  wa_bbpa: {
    id: "wa_bbpa",
    agency: "Washington State Office of the Insurance Commissioner",
    short: "OIC",
    unit: "Balance Billing Protection Act",
    role: "statutory_right",
    menuLabel: "Assert the Balance Billing Protection Act",
    menuHint:
      "Emergency care, out-of-network providers at in-network facilities, air ambulance — and (2025+ plans) ground ambulance under its own section.",
    handles:
      "Emergency services; non-emergency services by a non-participating provider at a participating facility; air ambulance; behavioral health emergency services. Ground ambulance is covered by a separate section, RCW 48.49.200.",
    cannot: [
      "Does not apply to plans providing benefits under chapter 74.09 RCW (Apple Health), and reaches a self-funded group health plan only if that plan has elected to participate under RCW 48.49.130.",
    ],
    phone: "800-562-6900",
    url: "https://www.insurance.wa.gov/insurance-resources/health-insurance/how-health-insurance-works/what-consumers-need-know-about-surprise-or-balance-billing",
    authority:
      "Chapter 48.49 RCW. Applicability: automatic for state-regulated health plans and state and school employee benefit plans; opt-in only for self-funded groups (RCW 48.49.130). Ground ambulance: RCW 48.49.200, for health plans issued or renewed on or after January 1, 2025.",
    letterString:
      "This bill is barred by Washington's Balance Billing Protection Act, chapter 48.49 RCW. Under RCW 48.49.020(1), a nonparticipating provider or facility may not balance bill an enrollee for these services, and payment is determined under RCW 48.49.020(2). Please correct the account to ${inNetworkCostShare}. Under RCW 48.49.020(2)(c), any amount I paid in excess of the in-network cost-sharing amount must be refunded within thirty business days, with twelve percent interest thereafter.",
    /**
     * CITATION WARNING (memo 04 §0.5, flag 12 — DO NOT REGRESS). RCW 48.49.030
     * is NOT the general balance-billing rule: 2022 c 263 §8 narrowed it to
     * behavioral-health emergency services. The general prohibition is RCW
     * 48.49.020(1); the general refund is 48.49.020(2)(c). Citing .030 against
     * a hospital or ambulance company hands the biller a clean rebuttal. The
     * string below is ONLY for behavioral health emergency services.
     */
    letterStringBehavioralHealthEmergency:
      "This bill is barred by RCW 48.49.020(3), which prohibits a behavioral health emergency services provider from balance billing an enrollee for emergency services. Under RCW 48.49.030(1)(a) I satisfy my obligation to pay by paying the in-network cost-sharing amount specified in my health plan contract, and under RCW 48.49.030(1)(e) any excess I paid must be refunded within thirty business days, with twelve percent interest thereafter.",
    actionOnly: false,
    citationIds: ["wa_bbpa_chapter", "wa_bbpa_prohibition", "wa_bbpa_bh", "wa_bbpa_optin", "wa_bbpa_ground"],
    sources: [
      "https://app.leg.wa.gov/RCW/default.aspx?cite=48.49&full=true",
      "https://app.leg.wa.gov/RCW/default.aspx?cite=48.49.020",
      "https://app.leg.wa.gov/RCW/default.aspx?cite=48.49.030",
      "https://app.leg.wa.gov/RCW/default.aspx?cite=48.49.130",
      "https://app.leg.wa.gov/RCW/default.aspx?cite=48.49.200",
    ],
  },

  wa_doh: {
    id: "wa_doh",
    agency: "Washington State Department of Health",
    short: "DOH",
    unit: "Health Systems Quality Assurance (HSQA)",
    role: "licensing_discipline",
    menuLabel: "File a provider or facility complaint — DOH",
    menuHint: "Quality of care, unprofessional conduct, facility conditions. Not billing.",
    handles:
      "Complaints about credentialed health care providers and about the facilities DOH licenses, including hospitals, ambulatory surgical facilities, child birth centers, home health agencies, and behavioral health agencies. Professional conduct is governed by the Uniform Disciplinary Act, chapter 18.130 RCW.",
    cannot: [
      "Cannot get money back you feel is owed to you, handle a fee dispute between you and your provider, or resolve questions about insurance reimbursement.",
      "A refund of fees is available only as a disciplinary sanction under RCW 18.130.160(11), and only upon a finding, after hearing, that a license holder has committed unprofessional conduct — it is not a consumer remedy and cannot be requested.",
    ],
    phone: "360-236-4700",
    // hsqa.csc@doh.wa.gov is the general CUSTOMER SERVICE address, not
    // complaint intake (memo 04 flag 13 — fixed; do not regress).
    email: "HSQAComplaintIntake@doh.wa.gov",
    url: "https://doh.wa.gov/licenses-permits-and-certificates/file-complaint-about-provider-or-facility",
    authority: "Chapter 18.130 RCW (Uniform Disciplinary Act)",
    // S325 ruling: actionOnly. The canonical draft carried a composable DOH
    // sentence, but memo 05 §0 (later, adopted by review doc §3.2) bars
    // naming a licensing forum inside a money letter — and DOH's own page
    // says it does not handle billing. The standalone clinical-conduct
    // letter (its own artifact, no dollar amounts) is the eleven-rules lane.
    letterString: null,
    actionOnly: true,
    citationIds: ["wa_uda", "wa_uda_refund"],
    sources: [
      "https://doh.wa.gov/licenses-permits-and-certificates/file-complaint-about-provider-or-facility",
      "https://doh.wa.gov/licenses-permits-and-certificates/file-complaint-about-provider-or-facility/health-professions-complaint-process",
      "https://app.leg.wa.gov/RCW/default.aspx?cite=18.130.160",
    ],
  },

  wa_ag: {
    id: "wa_ag",
    agency: "Washington State Office of the Attorney General",
    short: "Attorney General",
    unit: "Consumer Protection Division — Consumer Resource Center",
    role: "law_enforcement",
    menuLabel: "File a consumer complaint — Washington Attorney General",
    menuHint:
      "Deceptive billing, abusive collections, charity-care violations — the office that has actually enforced these against hospitals.",
    handles:
      "Unfair or deceptive acts or practices in trade or commerce under the Consumer Protection Act, chapter 19.86 RCW — including deceptive billing, billing for services not rendered, and abusive collection practices. Offers an informal complaint resolution service. Also the office that has litigated hospital charity care compliance.",
    cannot: [
      "Is authorized to bring legal action only in the name of the State of Washington, and is prohibited from serving as an attorney for individual consumers.",
    ],
    phone: "1-800-551-4636",
    url: "https://www.atg.wa.gov/file-complaint",
    authority: "RCW 19.86.020; RCW 19.86.080",
    letterString:
      "If this is not corrected, I will file a complaint with the Washington State Office of the Attorney General, Consumer Protection Division, which enforces the Consumer Protection Act, chapter 19.86 RCW, against unfair and deceptive billing practices.",
    actionOnly: false,
    citationIds: ["wa_cpa", "wa_cpa_enforcement"],
    sources: [
      "https://www.atg.wa.gov/file-complaint",
      "https://www.atg.wa.gov/consumer-protection",
      "https://www.atg.wa.gov/charitycare",
      "https://app.leg.wa.gov/RCW/default.aspx?cite=19.86.080",
    ],
  },

  wa_charity_care: {
    id: "wa_charity_care",
    agency: "Washington State Department of Health",
    short: "DOH",
    unit: "Charity care — RCW 70.170.060",
    role: "statutory_right",
    menuLabel: "Assert Washington hospital charity care",
    menuHint:
      "Hospital bills: sliding-scale relief up to 100% by income tier, screening must precede collection, and DOH + the AG both take violations.",
    handles:
      "Hospital charity care obligations. Complaints go to DOH, the Attorney General, or both — each solicits them on its own site.",
    cannot: [],
    phone: "360-236-4700",
    url: "https://doh.wa.gov/data-statistical-reports/healthcare-washington/hospital-and-patient-data/hospital-patient-information-and-charity-care",
    deadline:
      "Do not state a deadline. The statute contemplates an application within two years of the date of service for income-measurement purposes, and permits a hospital to consider applications at any time — but that is discretionary, not a patient right.",
    authority: "RCW 70.170.060; WAC 246-453-020; enforcement penalties at RCW 70.170.070",
    letterString:
      "I am applying for charity care under RCW 70.170.060. My family income is within the threshold your hospital is required to apply. Under RCW 70.170.060(10)(c), an initial determination of sponsorship status must precede collection efforts directed at the patient, so please suspend collection on this account. If you consider assets, RCW 70.170.060(5)(c)(iii) limits verification requests to what is reasonably necessary and readily available and provides that only those facts relevant to eligibility may be verified and that duplicate forms of verification may not be demanded; (5)(c)(iii)(A) provides that one current account statement is sufficient to verify a patient's assets; and (5)(c)(iv) provides that asset information obtained in evaluating charity care eligibility may not be used for collection activities.",
    actionOnly: false,
    citationIds: ["wa_charity_statute", "wa_charity_wac", "wa_charity_penalties"],
    sources: [
      "https://app.leg.wa.gov/RCW/default.aspx?cite=70.170.060",
      "https://app.leg.wa.gov/WAC/default.aspx?cite=246-453-020",
      "https://doh.wa.gov/data-statistical-reports/healthcare-washington/hospital-and-patient-data/hospital-patient-information-and-charity-care",
      "https://www.atg.wa.gov/charitycare",
    ],
  },
};

/**
 * WA charity-care sliding scale, RCW 70.170.060(5). "Tier 1/2" are DOH's
 * administrative labels, NOT statutory terms; never assert a hospital's group
 * without checking DOH's published list. The 75%/50% steps — not the full
 * write-off — may be reduced by assets considered under (5)(c).
 */
export const WA_CHARITY_CARE_SCALE = {
  groupA: [
    { fplMax: 300, discount: 100 },
    { fplMin: 301, fplMax: 350, discount: 75 },
    { fplMin: 351, fplMax: 400, discount: 50 },
  ],
  groupB: [
    { fplMax: 200, discount: 100 },
    { fplMin: 201, fplMax: 250, discount: 75 },
    { fplMin: 251, fplMax: 300, discount: 50 },
  ],
} as const;

// ===========================================================================
// FEDERAL + GENERIC (the pre-S325 doors live here as data — one registry)
// ===========================================================================

export const FEDERAL_FORUMS: Record<string, Forum> = {
  dol_ebsa: {
    id: "dol_ebsa",
    agency: "United States Department of Labor, Employee Benefits Security Administration",
    short: "EBSA",
    role: "federal_backstop",
    menuLabel: "Contact the U.S. Department of Labor (self-funded employer plans)",
    menuHint: "If your employer pays claims from its own funds, no state insurance regulator has jurisdiction.",
    handles:
      "Self-funded (self-insured) employer and union plans governed by ERISA. Neither California agency nor the Washington OIC regulates these.",
    cannot: [],
    // NOTE: 1-866-275-7922 appears on a CDI page — it is the retired 2002 PWBA
    // number (memo 04 §1.3). Do not use it.
    phone: "1-866-444-3272",
    url: "https://www.dol.gov/agencies/ebsa",
    letterString:
      "Because this is a self-funded employer plan governed by ERISA, I will take this to the United States Department of Labor, Employee Benefits Security Administration (1-866-444-3272).",
    actionOnly: false,
    citationIds: [],
    sources: [
      "https://www.dol.gov/general/contact/contact-phone-call-center",
      "https://www.insurance.ca.gov/01-consumers/110-health/10-basics/overview.cfm",
    ],
  },

  cms_no_surprises: {
    id: "cms_no_surprises",
    agency: "Centers for Medicare & Medicaid Services",
    short: "CMS",
    unit: "No Surprises Help Desk",
    role: "federal_backstop",
    menuLabel: "CMS No Surprises Help Desk",
    menuHint: "Surprise billing, good-faith-estimate violations",
    handles:
      "Suspected No Surprises Act violations. In California and Washington this is mainly the right forum for the gaps in state law: self-funded plans that have not opted in, care received out of state, and air ambulance.",
    cannot: [
      "Does not cover Medicare (including Advantage), Medicaid (including managed care), TRICARE, Indian Health Service, or Veterans Health Administration beneficiaries.",
    ],
    phone: "1-800-985-3059",
    url: "https://www.cms.gov/medical-bill-rights/help/submit-a-complaint",
    letterString:
      "This bill appears to violate the federal No Surprises Act. I intend to submit a complaint to the No Surprises Help Desk (1-800-985-3059).",
    actionOnly: false,
    citationIds: [],
    sources: [
      "https://www.cms.gov/medical-bill-rights/help/plan/call-help-desk",
      "https://www.cms.gov/files/document/nsa-surprise-billing-decision-tree.pdf-0",
    ],
  },

  // -------------------------------------------------------------------------
  // The four PRE-S325 generic doors (Pack D, S297/S303), folded in as data so
  // ONE registry exists. Their menuLabel/menuHint/url/phone reproduce the
  // retired COMPLAINT_DOORS literals BYTE-EXACT — pack-registry projects these
  // back into the ComplaintDoor shape, so flag-OFF renders are byte-identical.
  // -------------------------------------------------------------------------
  generic_ag: {
    id: "ag",
    agency: "State attorney general",
    short: "State AG",
    role: "law_enforcement",
    menuLabel: "State attorney general",
    menuHint: "Hospital billing practices, collection abuse, charity care",
    handles: "Consumer-protection enforcement against unfair or deceptive billing and collection practices.",
    cannot: [],
    url: "https://www.naag.org/find-my-ag/",
    letterString: null,
    actionOnly: false,
    citationIds: [],
    sources: ["https://www.naag.org/find-my-ag/"],
  },
  generic_cfpb: {
    id: "cfpb",
    agency: "Consumer Financial Protection Bureau",
    short: "CFPB",
    role: "consumer_complaint",
    menuLabel: "CFPB",
    menuHint: "Debt collectors, credit-report errors",
    handles: "Complaints about debt collectors and consumer-credit reporting.",
    cannot: [],
    url: "https://www.consumerfinance.gov/complaint/",
    letterString: null,
    actionOnly: false,
    citationIds: [],
    sources: ["https://www.consumerfinance.gov/complaint/"],
  },
  generic_cms: {
    id: "cms",
    agency: "CMS No Surprises Help Desk",
    short: "CMS",
    role: "federal_backstop",
    menuLabel: "CMS No Surprises Help Desk",
    menuHint: "Surprise billing, good-faith-estimate violations",
    handles: "Suspected No Surprises Act violations.",
    cannot: [],
    phone: "1-800-985-3059",
    url: "https://www.cms.gov/medical-bill-rights/help/submit-a-complaint",
    letterString: null,
    actionOnly: false,
    citationIds: [],
    sources: ["https://www.cms.gov/medical-bill-rights/help/submit-a-complaint"],
  },
  generic_doi: {
    id: "doi",
    agency: "State insurance department",
    short: "State DOI directory",
    role: "consumer_complaint",
    menuLabel: "State insurance department",
    menuHint: "Insurer conduct, failed appeals",
    handles: "Market-conduct complaints against the member's insurer (via the NAIC national directory).",
    cannot: [],
    url: "https://content.naic.org/consumer/how-to-file-complaint",
    letterString: null,
    actionOnly: false,
    citationIds: [],
    sources: ["https://content.naic.org/consumer/how-to-file-complaint"],
  },
};

export const ALL_FORUMS: Record<string, Forum> = {
  ...CA_FORUMS,
  ...CA_PROVIDER_CONDUCT_FORUMS,
  ...CA_BILLING_CONDUCT_FORUMS,
  ...WA_FORUMS,
  ...FEDERAL_FORUMS,
};

// ===========================================================================
// ROUTING — member-supplied facts only
// ===========================================================================

export interface RouteInput {
  state: string | null;
  coverage: CoverageType;
  dispute: DisputeKind;
  /** Required when state === 'CA' and coverage === 'commercial_fully_insured'. */
  caRegulator?: CaRegulator;
  /** WA self-funded only: has the plan elected into the BBPA under RCW 48.49.130? */
  waSelfFundedOptedIn?: boolean;
}

export interface RouteResult {
  forums: Forum[];
  /** Blocking copy shown instead of (or above) forums when jurisdiction is elsewhere. */
  notice?: string;
}

/** The honest empty-state sentence (invariant 4). */
export const NO_FORUM_NOTICE =
  "No California regulator handles a complaint that a bill is simply too high. When nothing about the bill is wrong, the routes are negotiation with the provider and small claims court.";

export function route(input: RouteInput): RouteResult {
  const { state, coverage, dispute } = input;

  // Verified state modules exist for CA and WA only; everything else gets the
  // generic fallback pool (the pre-S325 doors) via fallbackForums().
  if (state !== "CA" && state !== "WA") return { forums: fallbackForums() };

  // --- Coverage types no state insurance regulator reaches -----------------
  if (coverage === "employer_self_funded") {
    const forums = [FEDERAL_FORUMS.dol_ebsa];
    if (dispute === "balance_bill") {
      if (state === "WA" && input.waSelfFundedOptedIn) forums.unshift(WA_FORUMS.wa_bbpa);
      else forums.push(FEDERAL_FORUMS.cms_no_surprises);
    }
    return {
      forums,
      notice:
        state === "WA"
          ? 'Self-funded employer plans are excluded from the definition of "health plan" in RCW 48.43.005, so the Insurance Commissioner does not regulate them. A self-funded plan is reached by the Balance Billing Protection Act only if it has elected to participate under RCW 48.49.130 — check the OIC’s published list of participating plans before asserting it.'
          : "Self-insured plans follow ERISA and are regulated by the U.S. Department of Labor. Neither the DMHC nor the CDI has jurisdiction.",
    };
  }

  if (coverage === "medicare") {
    return {
      forums: [],
      notice:
        "Medicare and Medicare Advantage are federal. Use the Medicare appeal process (1-800-MEDICARE / 1-800-633-4227, TTY 1-877-486-2048). In California, free counseling is available from HICAP at 1-800-434-0222. The No Surprises Act does not cover Medicare beneficiaries.",
    };
  }

  if (coverage === "medicaid") {
    return {
      forums: state === "CA" ? [CA_FORUMS.ca_dmhc_imr, CA_FORUMS.ca_dmhc_complaint] : [],
      notice:
        state === "CA"
          ? "Most Medi-Cal managed care plans are Knox-Keene licensed, so DMHC IMR is available — but not to Medi-Cal fee-for-service members, and not under some COHS arrangements. A managed care member may pursue the DMHC IMR (180 days from the Notice of Appeal Resolution) and a CDSS State Hearing (120 days from the same notice) at the same time. Order matters: after a State Hearing has occurred, an IMR can no longer be requested — so request the IMR first. Fee-for-service members have 90 days from the Notice of Action to request a State Hearing. The DHCS Ombudsman (1-888-452-8609) does not conduct formal investigations and preserves no deadlines."
          : "Chapter 48.49 RCW does not apply to health plans providing benefits under chapter 74.09 RCW. Route Apple Health disputes to the Health Care Authority (800-562-3022), not the Insurance Commissioner.",
    };
  }

  // --- Provider-side disputes: the plan's regulator is the wrong forum -----
  if (dispute === "provider_clinical_conduct") {
    // ALL entries actionOnly — surfaced as file-it-yourself links, routed by
    // license via CA_CLINICAL_BY_LICENSE in the UI (invariants 1 + 2).
    return state === "WA"
      ? { forums: [WA_FORUMS.wa_doh] }
      : { forums: Object.values(CA_PROVIDER_CONDUCT_FORUMS) };
  }

  if (dispute === "provider_billing_conduct") {
    return state === "WA"
      ? { forums: [WA_FORUMS.wa_ag, WA_FORUMS.wa_doh] }
      : {
          // Bill is HIGH, not wrong → NO CA regulator (invariant 4): the UI
          // shows NO_FORUM_NOTICE when the member's grievance is price-level.
          // These forums address CONDUCT (deception, collections, fraud).
          forums: [
            CA_BILLING_CONDUCT_FORUMS.ca_ag_piu,
            CA_BILLING_CONDUCT_FORUMS.ca_dfpi,
            CA_BILLING_CONDUCT_FORUMS.ca_da_consumer,
            CA_BILLING_CONDUCT_FORUMS.ca_cdi_fraud,
          ],
        };
  }

  if (dispute === "hospital_bill_affordability") {
    return state === "CA"
      ? { forums: [CA_FORUMS.ca_hcai_charity_care] }
      : { forums: [WA_FORUMS.wa_charity_care, WA_FORUMS.wa_ag] };
  }

  // --- Fully insured commercial (and public-employee) ----------------------
  if (state === "WA") {
    if (dispute === "balance_bill") return { forums: [WA_FORUMS.wa_bbpa, WA_FORUMS.wa_oic_complaint] };
    if (dispute === "medical_necessity_denial" || dispute === "experimental_denial") {
      return { forums: [WA_FORUMS.wa_oic_external_review, WA_FORUMS.wa_oic_complaint] };
    }
    return { forums: [WA_FORUMS.wa_oic_complaint] };
  }

  // California, fully insured. Default to DMHC on 'unknown' (it forwards).
  const reg = input.caRegulator === "CDI" ? "CDI" : "DMHC";
  if (dispute === "medical_necessity_denial" || dispute === "experimental_denial") {
    return {
      forums:
        reg === "CDI"
          ? [CA_FORUMS.ca_cdi_imr, CA_FORUMS.ca_cdi_complaint]
          : [CA_FORUMS.ca_dmhc_imr, CA_FORUMS.ca_dmhc_complaint],
    };
  }
  return { forums: reg === "CDI" ? [CA_FORUMS.ca_cdi_complaint] : [CA_FORUMS.ca_dmhc_complaint] };
}

/**
 * The ONE accessor letters use for a forum's sentence (invariant 2): an
 * actionOnly forum reaching the composer is a bug upstream — throw, never
 * render. CRPC 3.10 / Pen. Code §§518–519: a licensing or criminal forum
 * named in a demand letter is the prohibited shape.
 */
export function forumLetterString(forum: Forum): string {
  if (forum.actionOnly || forum.letterString === null) {
    throw new Error(
      `forum "${forum.id}" is action-only — it may never be composed into a letter; surface it as a post-letter action the member files themselves`,
    );
  }
  return forum.letterString;
}

/** The generic fallback pool — the four pre-S325 doors, in their fixed order. */
export function fallbackForums(): Forum[] {
  return [
    FEDERAL_FORUMS.generic_ag,
    FEDERAL_FORUMS.generic_cfpb,
    FEDERAL_FORUMS.generic_cms,
    FEDERAL_FORUMS.generic_doi,
  ];
}

/** Fixed, identical-for-everyone ordering (R14): role order, then id. */
export function orderForums(forums: readonly Forum[]): Forum[] {
  return [...forums].sort((a, b) => {
    const r = FORUM_ROLE_ORDER.indexOf(a.role) - FORUM_ROLE_ORDER.indexOf(b.role);
    return r !== 0 ? r : a.id.localeCompare(b.id);
  });
}

/** Every forum keyed by its public id (ids fixture-proven unique). */
export const FORUM_BY_ID: Record<string, Forum> = Object.fromEntries(
  Object.values(ALL_FORUMS).map((f) => [f.id, f]),
);

/**
 * The member's answer to "what did the plan's letter say the denial was based
 * on?" — a fact read off their own denial notice (never a detector). Narrows
 * the insurer-letter DisputeKind: IMR forums exist only for the first two.
 */
export type DenialBasis = "medical_necessity" | "experimental" | "other";

export function disputeKindForInsurerLetter(basis: DenialBasis): DisputeKind {
  return basis === "medical_necessity"
    ? "medical_necessity_denial"
    : basis === "experimental"
      ? "experimental_denial"
      : "claim_billing_dispute";
}

/**
 * The routed letter-consequence sentence (site B upgrade, PR-B): when the
 * member's own screening answers identify their regulator, the letter's
 * closing names it with the counsel-verified sentence; otherwise null and the
 * caller falls back to the neutral constant. Data-driven, flag-independent:
 * the classification exists only when the flag-ON screening wrote it, so
 * flag-OFF letters are byte-identical to the neutral PR-A output.
 *
 * Deliberately narrow: only the single payer-complaint forum for insurer
 * letters (DMHC/CDI/OIC complaint tracks) and the state AG consumer-protection
 * sentence for provider letters. Self-funded / Medicare / Medicaid / unknown →
 * null (neutral) — their jurisdiction lives outside these sentences.
 */
export function routedConsequence(
  classification: RegulatoryClassification | null | undefined,
  userState: string | null | undefined,
  recipient: "insurer" | "provider",
): string | null {
  if (!classification || (userState !== "CA" && userState !== "WA")) return null;
  if (classification.coverageType !== "commercial_fully_insured") return null;
  if (recipient === "provider") {
    const f = userState === "CA" ? CA_BILLING_CONDUCT_FORUMS.ca_ag_piu : WA_FORUMS.wa_ag;
    return ` ${forumLetterString(f)}`;
  }
  const result = route({
    state: userState,
    coverage: classification.coverageType,
    dispute: "claim_billing_dispute",
    caRegulator: classification.caRegulator,
  });
  const complaint = result.forums.find((f) => f.role === "consumer_complaint" && !f.actionOnly);
  return complaint ? ` ${forumLetterString(complaint)}` : null;
}

// ===========================================================================
// DEAD ENDS — an empty menu is a product failure; render these instead.
// ===========================================================================

export const DEAD_END_REFERRALS: Partial<Record<CoverageType, string>> = {
  medicare:
    "Neither state health regulator handles Medicare. The federal Centers for Medicare & Medicaid Services regulates these plans. Start with your plan's own appeal process, then 1-800-MEDICARE (1-800-633-4227).",
  medicaid:
    "Fee-for-service Medicaid is outside the state insurance regulators. In Washington, Apple Health is administered by the Health Care Authority, 800-562-3022; in California, Medi-Cal fee-for-service uses the CDSS State Hearing process.",
};

// ===========================================================================
// INTERNAL-ONLY data — never letter copy
// ===========================================================================

/**
 * DMHC/CDI enrollment split (CHCF almanac, Dec 2024 data). INTERNAL ROUTING
 * PRIOR ONLY — never printed in a letter (the fixture bans importing this
 * from letter-emitting template code). CHCF never prints "94%"; it is
 * arithmetic on rounded figures, and the denominator is load-bearing.
 */
export const ENROLLMENT_SPLIT = {
  source: "California Health Insurers, Enrollment Almanac — 2025 Edition (CHCF)",
  dataAsOf: "December 2024",
  commercialMillions: { dmhc: 13.0, cdi: 0.8 },
  dmhcShareOfFullyInsuredCommercial: 0.942,
  useAsLetterCopy: false,
} as const;

// ===========================================================================
// STALENESS — the re-verification contract
// ===========================================================================

export const VERIFIED_ON = "2026-08-26";

/** Re-check before each release touching this module; the operational
 *  calendar lives in the dispute-letters post-launch tracker. */
export const RECHECK_BEFORE_RELEASE = [
  "All phone numbers and TTY lines against each agency's own contact page (CDI still prints a number retired in 2002).",
  "The OIC's self-funded BBPA opt-in list — no 'last updated' stamp; check at request time, never cached.",
  "RCW 48.43.535 has a second version effective 2027-01-01; re-diff subsection (6) after that date.",
  "RCW 70.170.060 FPL tiers each session-year (unchanged since 2022 c 197 as of this date).",
  "The Hospital Fair Pricing Act (H&S 127400 et seq.) — semiannual; AB 1312's screening duty starts 2027-07-01 and must NOT be asserted before then.",
  "CHCF enrollment almanac — annually each December.",
] as const;
