/**
 * Guided Steps v1 — pack registry (S297).
 *
 * Pure data + pure functions. NO IO, no fetches, no React. Components feed the
 * ALREADY-FETCHED page payload in as a narrow GuideFillContext projection and
 * render what comes back — the one-derivation invariant (S292) extended to
 * scripts: fill-slots read the same values the page/letter renders from, so a
 * script and its letter can never disagree on one page.
 *
 * Copy is Andrew-approved VERBATIM (handoff §5–§7 tables + the S297 §2
 * decisions block). Do not wordsmith during maintenance; string changes go
 * back to Andrew inline first.
 *
 * Contract highlights (handoff §3):
 *  - Attested-only checkboxes: a step never claims Candid did/will do anything.
 *  - Autofill honesty: every script builder is TOTAL — a missing required slot
 *    returns null (the component renders the "Have ready" prep-chip path),
 *    never prose with holes.
 *  - Step ids are stable and match the checklist routes' KEY_RE.
 */

/** Mirrors the checklist routes' key validation — ids here MUST pass it. */
export const GUIDE_KEY_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;

/** One run of script prose; `fill: true` spans render highlighted (autofilled). */
export type ScriptSegment = { text: string; fill?: boolean };

/** A flagged finding, projected for clause composition (provider track). */
export type GuideFinding = {
  /** Audit finding type, e.g. "duplicate", "unbundling". */
  type: string;
  lineNumber: number | null;
  /** Display-ready service date for the clause, e.g. "March 3". */
  dateLabel: string | null;
  /** Plain noun for the service, e.g. "blood count". */
  serviceNoun: string | null;
  /** Unbundling only — the parent service that already includes this one. */
  parentLabel: string | null;
};

/**
 * Narrow projection of the claim page's already-rendered payload. `null` means
 * "not on file" — 0 is a real value (the insurer-track case IS insurerPaid=0).
 */
export type GuideFillContext = {
  track: "insurer" | "provider";
  /** Service label AS THE LETTER RENDERS IT; builder lowercases for prose. */
  serviceLabel: string | null;
  /** Long-form date of service, e.g. "March 14, 2026". */
  dosLong: string | null;
  providerName: string | null;
  billedAmount: number | null;
  /** The step-2 card's verdict string, e.g. "covered with 0% coinsurance". */
  planVerdictLabel: string | null;
  insurerPaid: number | null;
  patientPaid: number | null;
  accountNumber: string | null;
  claimNumber: string | null;
  memberIdOnFile: boolean;
  planNameOnFile: boolean;
  /** Billing-office phone from the bill parse (claim metadata), if captured. */
  providerPhone: string | null;
  /** Insurer member-services phone — no schema field holds one today; kept in
   *  the contract so a future card-parse field lights up honestly. */
  memberServicesPhone: string | null;
  findings: GuideFinding[];
  flaggedCount: number;
  flaggedTotal: number | null;
};

export type GuideCtaKind =
  | "itemized_request"
  | "dispute_letter"
  | "debt_validation"
  | "report_outcome"
  | "letter_pdf";

export type GuideStep = {
  /** Stable, KEY_RE-valid, namespaced (packA:/packC:/packD:). */
  id: string;
  title: string;
  /** Static copy line, or a fill-aware builder (null → omit the line). */
  copy: string | ((ctx: GuideFillContext) => ScriptSegment[] | null);
  /** Phone script; null → no script block (prep-chip path). */
  script?: (ctx: GuideFillContext) => ScriptSegment[] | null;
  /** Small line under the script block (insurer step 1 only today). */
  underScript?: string;
  control: "checkbox" | "derived" | "cta" | "info";
  /** Required when control === "checkbox". */
  checkboxLabel?: string;
  note?: { placeholder: string };
  cta?: { label: string; kind: GuideCtaKind };
};

// ── Formatting helpers (pure, deterministic) ────────────────────────────────

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const seg = (text: string): ScriptSegment => ({ text });
const fill = (text: string): ScriptSegment => ({ text, fill: true });

// ── Pack A′ — insurer-track variant (§5.3) ──────────────────────────────────

const insurerCallScript = (ctx: GuideFillContext): ScriptSegment[] | null => {
  if (
    ctx.serviceLabel == null ||
    ctx.dosLong == null ||
    ctx.providerName == null ||
    ctx.billedAmount == null ||
    ctx.planVerdictLabel == null ||
    ctx.insurerPaid == null ||
    ctx.patientPaid == null
  ) {
    return null;
  }
  return [
    seg("Hi — I'm calling about a claim for "),
    fill(ctx.serviceLabel.toLowerCase()),
    seg(" on "),
    fill(ctx.dosLong),
    seg(" at "),
    fill(ctx.providerName),
    seg(", billed at "),
    fill(fmtUsd(ctx.billedAmount)),
    seg(". My plan documents show this service is "),
    fill(ctx.planVerdictLabel),
    seg(", but the plan paid "),
    fill(fmtUsd(ctx.insurerPaid)),
    seg(" and I paid "),
    fill(fmtUsd(ctx.patientPaid)),
    seg(
      " out of pocket. Can you tell me why? If it was processed incorrectly, please reprocess it — and if it was denied, send me the denial reason in writing. Can I get your name and a reference number for this call?",
    ),
  ];
};

const billingHoldScript = (ctx: GuideFillContext): ScriptSegment[] | null => {
  if (ctx.dosLong == null) return null;
  return [
    seg("Hi — I'm calling about my "),
    fill(ctx.dosLong),
    seg(
      " visit. My insurer is re-reviewing the claim. Please place a hold on this account — no further billing or collection activity — while that review completes. Can I get your first name and a reference number for this call?",
    ),
  ];
};

export const PACK_A_INSURER_STEPS: GuideStep[] = [
  {
    id: "packA:ins-call-insurer",
    title: "Call your insurer — ask why this wasn't paid",
    copy: "This is the appeal's question, asked out loud. Misprocessed claims often get fixed on this call.",
    script: insurerCallScript,
    underScript:
      "every highlight autofilled from this bill and your plan — the same numbers the letter uses",
    control: "checkbox",
    checkboxLabel: "I made the call",
    note: { placeholder: "Enter the call reference #, name of the agent, and what you discussed" },
  },
  {
    id: "packA:ins-ask-hold",
    title: "Call the billing office — ask for a hold",
    copy: "Keeps the bill out of collections while your insurer re-reviews.",
    script: billingHoldScript,
    control: "checkbox",
    checkboxLabel: "I asked for the hold",
    note: { placeholder: "Enter the call reference #, name of the agent, and what you discussed" },
  },
  {
    id: "packA:ins-handoff",
    title: "No fix on the phone?",
    copy: "No fix on the phone? Send the appeal — it cites everything above, and what you logged here rides with your case.",
    control: "info",
  },
];

// ── Pack A′ — provider-track variant (§5.4) ─────────────────────────────────

/**
 * Finding → plain-language clause. Only mapped types emit; a clause with a
 * missing required slot is skipped (never a hole). Cap 3 + an "and N more"
 * tail. Returns [] when nothing composable — callers then use the
 * zero-findings degrade path (§5.5: never render "0 charges").
 */
export function composeFindingClauses(findings: GuideFinding[]): ScriptSegment[] {
  const clauses: ScriptSegment[][] = [];
  for (const f of findings) {
    if (f.type === "duplicate" || f.type === "duplicate_charge") {
      if (f.lineNumber == null || f.dateLabel == null || f.serviceNoun == null) continue;
      clauses.push([
        fill(
          `Line ${f.lineNumber}, dated ${f.dateLabel}, appears to be a duplicate — the same ${f.serviceNoun} is charged twice.`,
        ),
      ]);
    } else if (f.type === "unbundling") {
      if (f.lineNumber == null || f.serviceNoun == null || f.parentLabel == null) continue;
      clauses.push([
        fill(
          `Line ${f.lineNumber}, ${f.serviceNoun}, is billed alongside the ${f.parentLabel} that already includes it.`,
        ),
      ]);
    }
  }
  if (clauses.length === 0) return [];
  const capped = clauses.slice(0, 3);
  const out: ScriptSegment[] = [];
  capped.forEach((c, i) => {
    if (i > 0) out.push(seg(" "));
    out.push(...c);
  });
  const more = clauses.length - capped.length;
  if (more > 0) {
    out.push(seg(" "), fill(`And ${more} more on the corrected-bill review.`));
  }
  return out;
}

const itemizedRequestScript = (ctx: GuideFillContext): ScriptSegment[] => {
  // Account # is the only slot; absent → "my account" (approved degrade).
  const account: ScriptSegment[] =
    ctx.accountNumber != null ? [fill(`account #${ctx.accountNumber}`)] : [seg("my account")];
  return [
    seg("Hi — I'm calling about "),
    ...account,
    seg(
      ". Two things: First, please send me a fully itemized bill for this account, with each charge and its billing code, by mail or the portal. Second, please place a hold on this account — no further collection activity — while I review it. Can I get your first name and a reference number for this call?",
    ),
  ];
};

const flaggedChargesCopy = (ctx: GuideFillContext): ScriptSegment[] => {
  const clauses = composeFindingClauses(ctx.findings);
  if (ctx.flaggedCount > 0 && ctx.flaggedTotal != null && clauses.length > 0) {
    return [
      seg("Candid flagged "),
      fill(String(ctx.flaggedCount)),
      seg(ctx.flaggedCount === 1 ? " charge worth " : " charges worth "),
      fill(fmtUsd(ctx.flaggedTotal)),
      seg(". You're not arguing — you're stating a factual mismatch and starting a process."),
    ];
  }
  // Zero-findings degrade (§5.5) — verify-the-balance ask.
  return [
    seg(
      "You're not arguing — you're asking them to verify the balance against your records and put the result in writing.",
    ),
  ];
};

const flaggedChargesScript = (ctx: GuideFillContext): ScriptSegment[] => {
  const clauses = composeFindingClauses(ctx.findings);
  if (clauses.length === 0) {
    // Zero-findings degrade (§5.5) — never "0 charges", never an empty clause slot.
    return [
      seg(
        "I've reviewed the itemized bill against my records. Please verify the balance on this account against my medical records and insurance payments, and send me the corrected bill if anything doesn't match. What's the reference number for this review, and when will it be complete?",
      ),
    ];
  }
  return [
    seg("I've reviewed the itemized bill against my records, and I'm disputing specific charges. "),
    ...clauses,
    seg(
      " Please mark those charges as disputed on the account, open a billing review against my medical records, and send me the corrected bill when it's done. What's the reference number for this dispute, and when will the review be complete?",
    ),
  ];
};

const providerHandoffCopy = (ctx: GuideFillContext): ScriptSegment[] => {
  const composable = composeFindingClauses(ctx.findings).length > 0;
  if (ctx.flaggedCount > 0 && composable) {
    return [
      seg("Calls start the process; letters make the record. Your letter cites "),
      fill(String(ctx.flaggedCount)),
      seg(
        ctx.flaggedCount === 1
          ? " flagged charge and asks for the hold in writing."
          : " flagged charges and asks for the hold in writing.",
      ),
    ];
  }
  return [
    seg(
      "Calls start the process; letters make the record. Your letter asks for the hold in writing.",
    ),
  ];
};

export const PACK_A_PROVIDER_STEPS: GuideStep[] = [
  {
    id: "packA:prov-itemized",
    title: "Get the itemized bill",
    copy: "A summary bill can't be checked. The itemized statement lists every charge with its billing code.",
    script: itemizedRequestScript,
    control: "checkbox",
    checkboxLabel: "I have the itemized bill",
    cta: { label: "View your request letter", kind: "itemized_request" },
  },
  {
    id: "packA:prov-call-flagged",
    title: "Call the billing office about the flagged charges",
    copy: flaggedChargesCopy,
    script: flaggedChargesScript,
    control: "checkbox",
    checkboxLabel: "I made the call",
  },
  {
    id: "packA:prov-log-call",
    title: "Log the call",
    copy: "Who you talked to, the reference number, what they said. This log becomes your evidence if you escalate.",
    control: "info",
    note: { placeholder: "Enter the call reference #, name of the agent, and what you discussed" },
  },
  {
    id: "packA:prov-ask-hold",
    title: "Ask for a hold while it's reviewed",
    copy: "Part of script 1 — if you skipped it, call back. A hold keeps this bill away from collections during review.",
    script: () => [
      seg("Please place a hold on this account — no further collection activity — while I review it."),
    ],
    control: "checkbox",
    checkboxLabel: "I asked for the hold",
    note: { placeholder: "Enter the call reference #, name of the agent, and what you discussed" },
  },
  {
    id: "packA:prov-handoff",
    title: "Still unresolved? Put it in writing",
    copy: providerHandoffCopy,
    control: "info",
  },
];

export function packAStepsForTrack(track: "insurer" | "provider"): GuideStep[] {
  return track === "insurer" ? PACK_A_INSURER_STEPS : PACK_A_PROVIDER_STEPS;
}

/** Shared chrome strings (Andrew-approved S297). */
export const GUIDE_CHROME = {
  packATitle: "Work it by phone first",
  packAMeta: "optional · 10 min · 2 calls",
  expandLabel: "Show full step",
  collapseLabel: "Hide full step",
  doneMeta: (done: number, total: number) => `${done} of ${total} done`,
  haveReady: "Have ready:",
} as const;

/** Prep-chip strings — filled variants render only when genuinely on file. */
export const PREP_CHIPS = {
  memberIdOnFile: "member ID · on file from your card",
  planNameOnFile: "plan name · on file",
  claimNumberOnFile: "claim # · on file",
  claimNumberMissing: "claim # — add it if it's on your EOB",
  insurerPhoneMissing: "insurer phone — on the back of your insurance card",
  billingPhoneMissing: "billing office phone — it's printed on the bill",
} as const;

/** Filled phone lines (render only with a real on-file value). */
export const PHONE_LINES = {
  memberServices: (phone: string): ScriptSegment[] => [
    seg("Member services: "),
    fill(phone),
    seg(" — from your insurance card"),
  ],
  billingOffice: (phone: string): ScriptSegment[] => [
    seg("Billing office: "),
    fill(phone),
    seg(" — from this bill"),
  ],
} as const;

/** How many attestable checkboxes a step list carries (the "M" in "N of M done"). */
export function countCheckboxSteps(steps: GuideStep[]): number {
  return steps.filter((s) => s.control === "checkbox").length;
}

// ── Pack C — collections guard-rail (§6) ────────────────────────────────────

export type PackCContext = {
  collectorName: string | null;
  /** Display-ready first-contact date, e.g. "Jul 12, 2026". Null → the page
   *  renders the EXISTING date-capture affordance instead of the derived row. */
  firstContactDateLabel: string | null;
  /** Display-ready first-contact + 30d — from the deadline engine's value
   *  where the GET provides it; display-only recompute otherwise. */
  validationDeadlineLabel: string | null;
};

// ── Collections steps (S301) — the guard-rail rebuilt as RAIL steps ─────────
//
// Andrew's S301 critique, applied:
//   1. "Collections guard-rail" told a user nothing about what was behind the
//      click. The header names the situation and the first move, and names the
//      agency when we know it.
//   2. NO CHECKBOXES. Every step is an ACTION — a button, or input(s) plus a
//      confirming button. The indicator is an empty circle that fills green with
//      a white check once done, matching the rest of the timeline.
//   3. Steps that already exist on the rail are NOT rebuilt here. "Your debt
//      validation letter is ready" is the rail's own send step and "What did the
//      collector do?" is its waiting card (already collections-specific: the
//      undated §1692g wait, the "Collection must pause" chip, the approved
//      what-happens-next rows). Re-creating either would put two doors on the
//      same act — exactly the duplication this relocation exists to dissolve.
//      So the registry holds only the FOUR net-new steps.
//   4. A skipped step is NOT green: light grey with a skip mark, never a check.
//      These attestations feed letters (the prior-contact recital) and the
//      flywheel, so "skipped" must never be readable as "done" — the rail may
//      not claim the user did something they didn't (S297 §3.2, attested-only).
//
// Timestamps: these persist through the CLAIM checklist route, whose stamps are
// server-side, so every completed step can say WHEN. That is also why they are
// claim-scoped — the collections track belongs to the bill, and escalate dedups
// debt_validation to one row per claim.

export type CollectionsStepAction =
  /** A single confirming button. */
  | { kind: "attest"; label: string }
  /** A date field plus its save button. */
  | { kind: "date"; label: string; saveLabel: string }
  /** A short text field plus its save button. */
  | { kind: "text"; label: string; placeholder: string; saveLabel: string };

export type CollectionsStep = {
  /** Stable, KEY_RE-valid. Persisted in claims.metadata.guideSteps. */
  id: string;
  title: string;
  body: string;
  action: CollectionsStepAction;
  /**
   * Whether the user may dismiss this step without doing it. Only the
   * tracking-number step is dismissible: not-paying, the first-contact date,
   * and the send are facts the track needs, not preferences.
   */
  skippable: boolean;
  /**
   * WHERE this step's done-ness comes from — and therefore what Undo reverses.
   *
   *   attestation → its own stored `checkedAt` (Undo un-attests)
   *   send        → the LETTER's send record (Undo routes through unsend)
   *   date        → a stored date (Undo clears it)
   *
   * DECLARED here rather than matched by step id in the rail composer. The
   * composer briefly carried five separate `step.id === "packC:…"` branches —
   * the exact shape of drift this unit exists to remove, since a new step would
   * have needed edits in two files to behave.
   */
  doneFrom: "attestation" | "send" | "date";
  /** Which side of this letter's send step the row belongs on, chronologically. */
  phase: "before-send" | "after-send";
};

/** Header. Names the agency when the claim knows it (S301 — it always has). */
export function collectionsTitle(collectorName: string | null): string {
  return collectorName
    ? `${collectorName} contacted you. View playbook.`
    : "A collector contacted you. View playbook.";
}

export const COLLECTIONS_STEPS: CollectionsStep[] = [
  {
    id: "packC:not-paid",
    title: "Don't pay anything yet",
    body: "From this moment, this dispute lives on paper — letters, certified mail, copies of everything. You're asking them to prove their case before any money moves.",
    action: { kind: "attest", label: "I haven't paid the collector" },
    skippable: false,
    doneFrom: "attestation",
    phase: "before-send",
  },
  {
    id: "packC:first-contact",
    // Replaces "First contact date — already on file", which asserted the date
    // WAS on file in precisely the state where it wasn't — and, being a derived
    // row, vanished silently when absent, taking the §1692g deadline sentence
    // with it. It is now an open step you can see and answer.
    title: "When did they first contact you?",
    body: "This starts the 30-day window to demand proof — FDCPA §1692g.",
    action: { kind: "date", label: "Date of their first contact", saveLabel: "Save date" },
    skippable: false,
    // The stored date IS the answer — keying this on a separate attestation is
    // what made the step show its date and stay blue forever (S301 E2E).
    doneFrom: "date",
    phase: "before-send",
  },
  {
    id: "packC:mailed",
    title: "Mail it certified",
    body: "Certified mail is what makes this provable. Keep your copy.",
    action: { kind: "attest", label: "I mailed it" },
    // NOT skippable (S301 refinement): this step IS mark-as-sent — the two are
    // bidirectional, so "skipping" it would mean skipping the send itself, which
    // is not a preference, just a not-yet. Its state derives from the letter's
    // own send record rather than a second boolean, which is what dissolves the
    // old Pack-C "I mailed it" / spine mail-certified duplication.
    skippable: false,
    doneFrom: "send",
    phase: "after-send",
  },
  {
    id: "packC:receipt",
    title: "Certified mail — staple the receipt to your copy",
    body: "That receipt is your proof you disputed inside the 30-day window.",
    action: {
      kind: "text",
      label: "USPS tracking number",
      placeholder: "USPS tracking number",
      saveLabel: "Save",
    },
    skippable: true,
    doneFrom: "attestation",
    phase: "after-send",
  },
];

/** Skip affordance + the resolved-state labels (S301, Andrew-approved). */
export const COLLECTIONS_CHROME = {
  skipLabel: "Skip",
  skippedLabel: "skipped",
  undoSkipLabel: "Undo",
} as const;

/** @deprecated S301 — superseded by COLLECTIONS_STEPS. Reachable only with
 *  `case_rail_v1` OFF, where GuidedPackCSection still mounts on the dispute
 *  page. Removed with the UnifiedTodo retirement (phase 3 remainder). */
export const PACK_C_TITLE = "Collections guard-rail";

export const PACK_C_STEPS: GuideStep[] = [
  {
    id: "packC:not-paid",
    title: "Don't pay anything yet",
    copy: "From this moment, this dispute lives on paper — letters, certified mail, copies of everything. You're asking them to prove their case before any money moves.",
    control: "checkbox",
    checkboxLabel: "I haven't paid the collector",
  },
  {
    id: "packC:first-contact",
    title: "First contact date — already on file",
    copy: "It powers the 30-day window below.",
    control: "derived",
  },
  {
    id: "packC:mailed",
    title: "Send your debt validation letter",
    copy: "It asks them to prove the debt; until they do, collection must pause. No apology, no finances, no admission the debt is yours.",
    control: "checkbox",
    checkboxLabel: "I mailed it",
    cta: { label: "Your letter is ready", kind: "debt_validation" },
  },
  {
    id: "packC:receipt",
    title: "Certified mail — staple the receipt to your copy",
    copy: "That receipt is your proof you disputed inside the 30-day window.",
    control: "checkbox",
    checkboxLabel: "Receipt saved",
    note: { placeholder: "USPS tracking number" },
  },
  {
    id: "packC:outcome",
    title: "What happened?",
    copy: "If they can't validate, they must stop collecting. If they verify the debt, your dispute continues — the next letters are ready when you are.",
    control: "cta",
    cta: { label: "Report what happened", kind: "report_outcome" },
  },
];

/** Derived-row copy: "«date», from your case details. It powers the 30-day window below." */
export function packCFirstContactCopy(ctx: PackCContext): ScriptSegment[] | null {
  if (ctx.firstContactDateLabel == null) return null;
  return [fill(ctx.firstContactDateLabel), seg(", from your case details. It powers the 30-day window below.")];
}

/** Step-3 deadline sentence — prepended to the static copy when the date exists. */
export function packCDeadlineSentence(ctx: PackCContext): ScriptSegment[] | null {
  if (ctx.validationDeadlineLabel == null) return null;
  return [
    seg("Strongest if sent by "),
    fill(ctx.validationDeadlineLabel),
    seg(" — 30 days from first contact, FDCPA §1692g."),
  ];
}

export const PACK_C_LETTER_FOOTNOTE = "free — you review and send everything";

// ── Pack D — regulator doors (§7) ───────────────────────────────────────────

export const PACK_D_TITLE = "Take it to a regulator";
export const PACK_D_META = "optional · your letters make the case";
export const PACK_D_DOORS_TITLE = "Pick your door — you can file with more than one";
export const PACK_D_DOORS_LEAD = "Match the door to who wronged you.";
export const PACK_D_SUGGESTED_CHIP = "suggested for this case";
export const PACK_D_CASE_FILE_CHIP = "Case file — Pro";

export type ComplaintDoor = {
  id: "ag" | "cfpb" | "cms" | "doi";
  name: string;
  desc: string;
  href: string;
  phone?: string;
};

export const COMPLAINT_DOORS: ComplaintDoor[] = [
  {
    id: "ag",
    name: "State attorney general",
    desc: "Hospital billing practices, collection abuse, charity care",
    href: "https://www.naag.org/find-my-ag/",
  },
  {
    id: "cfpb",
    name: "CFPB",
    desc: "Debt collectors, credit-report errors",
    href: "https://www.consumerfinance.gov/complaint/",
  },
  {
    id: "cms",
    name: "CMS No Surprises Help Desk",
    desc: "Surprise billing, good-faith-estimate violations",
    href: "https://www.cms.gov/medical-bill-rights/help/submit-a-complaint",
    phone: "1-800-985-3059",
  },
  {
    id: "doi",
    name: "State insurance department",
    desc: "Insurer conduct, failed appeals",
    href: "https://content.naic.org/consumer/how-to-file-complaint",
  },
];

export const PACK_D_STEPS: GuideStep[] = [
  {
    id: "packD:docs-ready",
    title: "Gather your paper trail",
    copy: "Attach the collection notice, your validation request, and the underlying dispute record.",
    control: "checkbox",
    checkboxLabel: "Documents ready",
    cta: { label: "Letter PDF", kind: "letter_pdf" },
  },
  {
    id: "packD:filed",
    title: "File it, then log the confirmation number",
    copy: "Keep it factual: dates, amounts, what you asked for, what they did. You'll get a confirmation number — save it, you can use it to add documents later.",
    control: "checkbox",
    checkboxLabel: "Complaint filed",
    note: { placeholder: "Door · confirmation number" },
  },
  {
    id: "packD:outcome",
    title: "Record the outcome",
    copy: "Most complaints get a company response within weeks. Regulators build enforcement from these over time — outcomes vary.",
    control: "cta",
    cta: { label: "Report what happened", kind: "report_outcome" },
  },
];

/**
 * Suggested-door chips (§7.2): track door first, then collections, then NSA.
 * Max 2, deterministic order.
 */
export function suggestDoors(input: {
  track: "insurer" | "provider";
  hasCollections: boolean;
  grounds: string[];
}): Array<ComplaintDoor["id"]> {
  const out: Array<ComplaintDoor["id"]> = [input.track === "provider" ? "ag" : "doi"];
  if (input.hasCollections) out.push("cfpb");
  if (input.grounds.includes("balance_billing")) out.push("cms");
  return out.slice(0, 2);
}

/**
 * Pack D placement predicate — the spine's terminal zone (§7): the track's
 * last rung reached (external_review / final_notice — where suggestNextStep
 * returns null on denial), or a resolved loss.
 */
export function isTerminalRung(input: { letterType: string | null; status: string | null }): boolean {
  if (input.status === "lost") return true;
  return input.letterType === "external_review" || input.letterType === "final_notice";
}

// ── Phone-outcome question (S297, Andrew) ───────────────────────────────────
// Replaces the passive hand-off row ONCE ≥1 call is attested. Both answers
// persist (claim-scoped, server-stamped; the answer rides in `note` as
// "yes"/"no"). "Not yet" re-surfaces the approved hand-off copy + pulses the
// letter CTA below; "Yes" shows the watch-for-the-corrected-EOB line — the
// honest yes-branch (phone fixes are promises until the corrected EOB lands).
export const PHONE_OUTCOME = {
  id: "packA:phone-outcome",
  question: "Did the calls fix it?",
  yesLabel: "Yes — it's resolved",
  noLabel: "Not yet",
  /** Yes-state line = "Resolved at «server date-time». " + the rest below. */
  resolvedAtPrefix: "Resolved at",
  yesLineRestInsurer:
    "Watch for the corrected bill or EOB — if nothing changes in 30 days, the appeal below will still be ready.",
  yesLineRestProvider:
    "Watch for the corrected bill or EOB — if nothing changes in 30 days, your letter below will still be ready.",
  /** 4a/4b split (S297) — collapsed-header chrome. (The skip affordance was
   *  removed at Andrew's call: the muted-but-clickable 4b button IS the
   *  click-through for non-callers; "skip" remains a tolerated stored value
   *  from earlier sessions.) */
  resolvedChipPrefix: "Resolved by phone",
} as const;

/** Step 4b — the letter step of the S297 4a/4b split. Title is track-aware;
 *  sub carries the approved hand-off sentence (its directive prefix now lives
 *  in the title + question); subResolved is the yes-state watch-guidance. */
export const GUIDE_4B = {
  titleInsurer: "Send the appeal",
  titleProvider: "Send the dispute letter",
  sub: "It cites everything above, and what you logged here rides with your case.",
  subResolved: "Still here if the fix doesn't land — watch for the corrected bill or EOB.",
} as const;

// ── Letter recital source (S297) — attested calls → letter facts ───────────

export type GuidedCallLogEntry = {
  kind: "insurer_call" | "billing_hold_call" | "itemized_request_call" | "flagged_charges_call";
  /** Server-issued checkedAt of the attestation. */
  calledAt: string;
  /** The user's log note — carried for future STRUCTURED use (tracker Item X);
   *  deliberately NOT rendered into letters in v1 (raw prose needs a voice pass). */
  note?: string;
};

const CALL_LOG_STEP_KINDS: Record<string, GuidedCallLogEntry["kind"]> = {
  "packA:ins-call-insurer": "insurer_call",
  "packA:ins-ask-hold": "billing_hold_call",
  "packA:prov-ask-hold": "billing_hold_call",
  "packA:prov-itemized": "itemized_request_call",
  "packA:prov-call-flagged": "flagged_charges_call",
};

/**
 * Project claims.metadata.guideSteps into letter-recital entries. Attested-only
 * (checkedAt present); one entry per kind (both tracks map their hold step to
 * billing_hold_call — earliest wins); chronological.
 */
export function guidedCallLogFromMeta(
  guideSteps:
    | Record<string, { checkedAt?: string | null; note?: string }>
    | null
    | undefined,
): GuidedCallLogEntry[] {
  if (!guideSteps) return [];
  const entries: GuidedCallLogEntry[] = [];
  for (const [stepId, kind] of Object.entries(CALL_LOG_STEP_KINDS)) {
    const row = guideSteps[stepId];
    if (!row || typeof row.checkedAt !== "string" || row.checkedAt.length === 0) continue;
    entries.push({
      kind,
      calledAt: row.checkedAt,
      note: typeof row.note === "string" && row.note.length > 0 ? row.note : undefined,
    });
  }
  entries.sort((a, b) => a.calledAt.localeCompare(b.calledAt));
  const seen = new Set<GuidedCallLogEntry["kind"]>();
  return entries.filter((e) => {
    if (seen.has(e.kind)) return false;
    seen.add(e.kind);
    return true;
  });
}

// ── All packs (fixture surface) ─────────────────────────────────────────────

export const ALL_GUIDE_STEPS: GuideStep[] = [
  ...PACK_A_INSURER_STEPS,
  ...PACK_A_PROVIDER_STEPS,
  ...PACK_C_STEPS,
  ...PACK_D_STEPS,
];

// ── Case rail (S299 — timeline unification phase 1a) ────────────────────────
// The extended claim rail's approved copy, VERBATIM. Sources: the approved
// S298 mock (plans/mocks/s298-extended-rail-mock.html, v4) · agenda §0.9d
// rulings 1/4/6/7 · net-new strings Andrew-approved S299 (day-grammar +
// overdue variants, door ack, "Open this letter", insurer fallback). Dates,
// names, and counts interpolate as arguments — copy changes go to Andrew
// BEFORE they land here. Exercised by fixtures/case-timeline/rail-steps.ts.

export const CASE_RAIL = {
  // Case-header chip (§0.9a rule 2d — projector-derived, never stored).
  headerChip: (waiting: number, firstDueLabel: string | null): string =>
    waiting === 1
      ? `Waiting on 1 response${firstDueLabel ? ` · due ${firstDueLabel}` : ""}`
      : `Waiting on ${waiting} responses${firstDueLabel ? ` · first due ${firstDueLabel}` : ""}`,

  // Waiting-step titles (ruling 4 grammar: "Waiting on «counterparty» — your «letter»").
  waitTitleAppeal: (insurer: string | null): string =>
    `Waiting on ${insurer ?? "your plan"} — your appeal`,
  waitTitleCollector: (collector: string | null): string =>
    `Waiting on ${collector ?? "the collector"}`,
  waitTitleGeneric: (counterparty: string, letterNoun: string): string =>
    `Waiting on ${counterparty} — your ${letterNoun}`,

  // Waiting-step subs — letter-type-keyed; other types render no sub.
  waitSubAppeal: "Your plan has 60 days to answer an internal appeal.",
  waitSubValidation:
    "They must prove this debt before they can collect — that's what your letter requires.",

  // Chips.
  chipSentAgo: (days: number): string =>
    days <= 0 ? "Sent today" : days === 1 ? "Sent 1 day ago" : `Sent ${days} days ago`,
  chipDeadline: (dateLabel: string, daysRemaining: number): string =>
    daysRemaining < 0
      ? `Their deadline: ${dateLabel} · passed`
      : daysRemaining === 0
        ? `Their deadline: ${dateLabel} · due today`
        : daysRemaining === 1
          ? `Their deadline: ${dateLabel} · 1 day left`
          : `Their deadline: ${dateLabel} · ${daysRemaining} days left`,
  chipCollectionPause: "Collection must pause until they prove the debt",

  // Card actions + doors.
  ctaLogResponse: "Log their response",
  doorSomethingElse: "Something else happened",
  doorCollectionResumed: "Collection resumed anyway",
  doorCollectionResumedAck: "Logged — this is on your case record.",
  ctaOpenLetter: "Open this letter",
  quietUndoResult: "Undo this result",

  // Reminder foot — dated waits only; hidden once the deadline passes.
  remindFoot: (dateLabel: string): string =>
    `We'll remind you before ${dateLabel} if nothing arrives.`,

  // "What happens next" (ruling 1 — display-only rows INSIDE the waiting card;
  // sets are per wait type, keyed by letter type; unlisted types omit the
  // section rather than shipping invented promises).
  whnHeading: "What happens next",
  whnAppeal: (deadlineLabel: string | null): Array<[string, string]> => {
    const rows: Array<[string, string]> = [
      ["They fix it and pay", "you mark the case resolved"],
      ["They say no", "your external-review letter is ready"],
    ];
    if (deadlineLabel) rows.push([`Nothing by ${deadlineLabel}`, "your follow-up letter is ready"]);
    return rows;
  },
  whnValidation: (): Array<[string, string]> => [
    ["They prove the debt", "your dispute continues, and the next letters are ready"],
    ["They can't prove it", "they must stop collecting"],
    ["Collection resumes without proof", "log it here — it goes on your case record"],
  ],

  // Receipts (ruling 4: "«outcome» · logged «date»").
  outcomeReceipt: (outcomeLabel: string, loggedLabel: string | null): string =>
    loggedLabel ? `${outcomeLabel} · logged ${loggedLabel}` : outcomeLabel,

  // Extension send-steps.
  sendTitleValidation: "Answer the collector",
  sendTitleGeneric: (letterNoun: string): string => `Send the ${letterNoun}`,
  sendReceiptValidation: (collector: string | null, dateLabel: string, certified: boolean): string =>
    `Debt-validation letter sent${collector ? ` to ${collector}` : ""} · ${dateLabel}${certified ? " · certified mail" : ""}`,
  sendReceiptGeneric: (letterLabel: string, dateLabel: string, certified: boolean): string =>
    `${letterLabel} sent · ${dateLabel}${certified ? " · certified mail" : ""}`,

  // Step-4b receipt subs (the primary letter's send step, per guided track).
  receipt4bInsurer: (insurer: string | null, dateLabel: string, certified: boolean): string =>
    `Appeal sent${insurer ? ` to ${insurer}` : ""} · ${dateLabel}${certified ? " · certified mail" : ""}`,
  receipt4bProvider: (provider: string | null, dateLabel: string, certified: boolean): string =>
    `Dispute letter sent${provider ? ` to ${provider}` : ""} · ${dateLabel}${certified ? " · certified mail" : ""}`,

  // ── Stage-8 "Your next move" (S299 phase 1b; mock Panel C, rulings 3/4/5) ──
  // Renders per letter at stage `next` (letter offer + regulator card) and at
  // resolved TERMINAL rungs (doors only — isTerminalRung). Card title reuses
  // PACK_D_TITLE; suggested chip reuses PACK_D_SUGGESTED_CHIP; the filed
  // attest reuses PACK_D_STEPS "packD:filed" verbatim. "Done here? Close the
  // case" is DEFERRED (Andrew, S299) — no closed-case state exists yet; it
  // lands with the Panel-D resolved fold.
  nextMoveTitle: "Your next move",
  nextMoveSubSaidNo: (counterparty: string): string =>
    `${counterparty} said no. Two paths are open — you can take both.`,
  nextMoveSubPaidPart: (counterparty: string): string =>
    `${counterparty} paid only part. Two paths are open — you can take both.`,
  nextMoveSubCounteroffer: (counterparty: string): string =>
    `${counterparty} made a counteroffer. Two paths are open — you can take both.`,
  startLetterCta: "Start the letter",
  startLetterSubExternalReview: (loggedLabel: string | null): string =>
    `An independent reviewer, not your insurer, decides.${loggedLabel ? ` Unlocked by the denial you logged ${loggedLabel}.` : ""}`,
  regulatorLead: "Choose the regulator(s) based on which party wronged you.",
  regulatorFoot:
    "Gather your paper trail → file it → log the confirmation number. Your letters make the case.",
  /** Rail-side filed-note placeholder (Andrew verbatim, S299 1b E2E) — the
   *  dispute-side PACK_D_STEPS row keeps its own until phase 3 retires it. */
  filedNotePlaceholder: "Enter your confirmation number",
  proChip: "Pro",
} as const;
