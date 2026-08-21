/**
 * Simplified onboarding — shared constants, approved copy, validation, and the
 * profile-strength model (2026-07-17 design handoff; plan:
 * onboarding_doc_first_reorder.md v10, S285).
 *
 * Everything here is consumed by BOTH the /onboarding flow and the dashboard
 * ProfileMeter so the two surfaces can never disagree about copy, weights, or
 * what counts as done. Pure module — no React, safe to import from fixtures.
 */

import { isDecoratedValue } from "../parser/consumer-read";

/** Flag gating the whole feature (seeded OFF by mig 207). */
export const SIMPLIFIED_ONBOARDING_FLAG = "onboarding_simplified_v1";

/** Post-signup + deep-link routes. */
export const ONBOARDING_PATH = "/onboarding";
export const LEGACY_WIZARD_PATH = "/profile?onboarding=true";

/* ── Approved copy — reassuring deck (Andrew sign-off via the design handoff;
      strings are asserted VERBATIM by scripts/onboarding-simplified-fixture.ts.
      Do not reword without a fresh copy approval.) ─────────────────────────── */

export const OB_COPY = {
  eyebrow: "WELCOME TO CANDID",
  later: "I'll do this later",
  s1Title: "Snap a photo of your insurance card",
  s1Sub: "It's the fastest way in — we read the card and fill in your insurer, member ID, group number, and copays for you. No typing.",
  s1TitleManual: "Add your insurance card",
  s1SubManual: "Just the IDs from the front of your card — they're the two things no other document has. Or drop a photo and we'll read it for you, copays included.",
  s1Skip: "No card handy? Skip — you can add it anytime",
  s2Title: "Add a plan document or a bill",
  s2Sub: "A plan document (SBC, EOC, booklet) fills in your coverage information like deductibles, OOP max, covered services. A bill or EOB gets audited for overcharges on the spot.",
  s2Skip: "Skip — we'll keep a reminder on your dashboard",
  s3Title: "Last thing — 30 seconds about you",
  s3Sub: "Just the things documents can't tell us. Everything else, Candid reads on its own.",
  s3Cta: "Finish — take me to my dashboard",
  continueCta: "Continue",
  consequence: "Without a card or plan document, Candid can't audit anything yet. That's okay — your dashboard will show exactly what's missing.",
  situationLabel: "What brings you here?",
  situationWhy: "Helps us run the right audit checks first.",
  /* S288 mode system (plan-change / about-you edit reuse of the flow) —
     copy APPROVED by Andrew S289 (2026-07-27); fixture-asserted verbatim. */
  cancel: "Cancel",
  done: "Done",
  saveChanges: "Save changes",
  planModeTitle: "Update your plan",
  planModeSub:
    "Replace your plan or insurance card by uploading a document or searching Candid's library.",
  /* S317 (Andrew, approved) — the plan-change page does two different jobs under
     one heading, and the card block had no heading at all, so it read as more of
     the plan form. Two titled sections, each stating what it changes and what it
     does not. ADDITIVE keys: the S289-approved strings above and in OB_DOC_COPY
     are untouched, so the signup flow and both verbatim fixtures are unaffected. */
  coverageModeTitle: "Update your coverage",
  coverageModeSub:
    "Change the plan we check your bills against, or update the ID numbers on your card.",
  planSectionTitle: "Update your plan",
  planSectionSub: "Sets your deductible, out-of-pocket max, and what's covered.",
  cardSectionTitle: "Update your insurance card",
  cardSectionSub:
    "The ID numbers a provider or insurer asks you for. Doesn't change your coverage terms.",
  /* S317 — fires only after a plan change in this session (an event, not a
     standing todo), so it retires with the event and asks again on the next
     change. Member ID is deliberately NOT pre-filled anywhere: a new plan almost
     always means a new member number, so carrying the old one over would assert
     something we do not know. The insurer DOES prefill from the new plan. */
  cardPromptTitle: "Does your card still match?",
  cardPromptBody:
    "Your plan changed, so the IDs on your card probably did too. These are what we put on letters to your insurer.",
  cardPromptUpdate: "Update card",
  cardPromptSkip: "Skip for now",
} as const;

/** Step names shown in the progress row. */
export const OB_STEP_NAMES = ["Insurance card", "Plan document", "About you"] as const;

/** Card-slot microcopy (from the design reference; part of the approved pack). */
export const OB_CARD_COPY = {
  dropline: "Faster with a photo?",
  droplineSub: "Drop or browse a shot of your card — we'll type all of this for you, plus plan type, copays, and Rx codes.",
  scanned: "Card read — details filled in",
  manualSaved: "Details saved",
  manualNote: "Entered manually — a document can verify this later",
  replace: "Replace",
  scanNote: "OCR · matching insurer · pulling IDs",
  save: "Save details",
  /* S288 both-or-neither (copy APPROVED by Andrew S289): a divergent card +
     "Keep current plan" writes NOTHING — this is the receipt. */
  keptNothing:
    "Kept your current plan — its insurer is filled in below. Check the member ID and group number are from that plan's card, then save.",
  /* S288 plan-change mode — current-card framing (copy APPROVED S289). */
  currentCardEyebrow: "YOUR CURRENT CARD",
  replaceCard: "Replace card",
} as const;

export const OB_DOC_COPY = {
  dropTitle: "Drop your plan document or a bill",
  // S322 — the ceiling derives from the live admin-tuned limit; the consumer
  // passes the current MB value (was a hardcoded "20 MB").
  dropSub: (maxFileMb: number) => `PDF, JPG, or PNG · up to ${maxFileMb} MB`,
  browse: "browse files",
  parseNote: "OCR · extracting benefits · indexing covered services",
  parsedPlan: "Parsed — coverage set up",
  parsedBill: "Audited — here's what we found",
  settling: "Pulling in your results…",
  explainer: [
    { tag: "PLAN DOC", items: "Deductibles · OOP max · covered services" },
    { tag: "BILL · EOB", items: "Line-item overcharge audit, on the spot" },
  ],
  /* S317 (Andrew) — plan-change mode variants. The shared strings above stay
     exactly as S289 approved them because in SIGNUP they are correct: there you
     genuinely may upload a plan document or a bill. On a plan change a bill is
     not the job, so advertising a line-item audit is noise. Mode-specific keys
     rather than edits, so signup and both verbatim fixtures are untouched. */
  planModeExplainer: [
    { tag: "PLAN DOC", items: "Deductibles · OOP max · covered services" },
  ],
  planModeDropTitle: "Drop your plan document",
  planModeSearchToggle: "No document handy? Search Candid's library instead",
  /* S288 plan-library search (upload's peer alternative) — copy APPROVED by
     Andrew S289 (2026-07-27); fixture-asserted verbatim. */
  searchToggle: "No document handy? Search for your plan instead",
  searchPlaceholder: "Plan name or insurer — e.g. UHC Gold Advantage",
  searchHint:
    "Picking your plan from Candid's library fills in your coverage like a document would. You can add the document anytime for verified details.",
  searchEmpty: "No matches — try fewer words, or upload a document instead.",
  searchSelecting: "Setting up your plan…",
  searchDone: "Plan on file — from Candid's plan library",
  searchError: "Couldn't find that plan. Please try again.",
  searchBack: "Back to upload",
  /* S288 plan-change mode — prominent current-plan framing (copy APPROVED S289). */
  currentPlanEyebrow: "YOUR CURRENT PLAN",
  replacePlan: "Replace plan",
} as const;

/** Dashboard meter copy (same approval). */
export const OB_METER_COPY = {
  nodocsTitle: "Your audits can't run yet — Candid has no coverage document",
  nodocsCta: "Finish setup",
  strengthLabel: "Profile strength",
  completeRow: "Profile complete — every audit runs at full accuracy.",
  review: "Review",
} as const;

/* ── Options (ids are the DB values — mig 208 CHECK lists must match) ─────── */

export const OB_HOUSEHOLD = [
  { id: "just_me", label: "Just me" },
  { id: "me_spouse", label: "Me + spouse" },
  { id: "me_kids", label: "Me + kid(s)" },
  { id: "me_spouse_kids", label: "Me + spouse + kid(s)" },
] as const;
export type HouseholdId = (typeof OB_HOUSEHOLD)[number]["id"];

export const OB_SITUATIONS = [
  { id: "er_bill", label: "ER bill" },
  { id: "oon_surprise_bill", label: "Surprise / out-of-network bill" },
  { id: "denied_claim", label: "Denied claim" },
  { id: "bill_too_high", label: "Bill seems too high" },
  { id: "hidden_benefits", label: "Looking for hidden plan benefits" },
  { id: "plan_shopping", label: "Shopping for a plan" },
  { id: "staying_ahead", label: "Just staying ahead" },
] as const;
export type SituationId = (typeof OB_SITUATIONS)[number]["id"];

/** profiles.sex CHECK values (0041_profile_demographics.sql). */
export const OB_SEX = [
  { id: "female", label: "Female" },
  { id: "male", label: "Male" },
  { id: "prefer_not_to_say", label: "Prefer not to say" },
] as const;

/* ── Validation + DOB mask (ported from the approved design reference) ────── */

/** ZIP: exactly 5 digits. */
export function obZipOk(zip: string | null | undefined): boolean {
  return /^\d{5}$/.test(zip || "");
}

/**
 * DOB display format MM/DD/YYYY: real calendar date, age ≥ 18 and < 120.
 * (The authoritative 18+ gate lives server-side in POST /api/profile; this is
 * the matching client rule so errors surface before submit.)
 */
export function obDobOk(dob: string | null | undefined): boolean {
  if (!dob) return false;
  const m = String(dob).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return false;
  const d = new Date(+m[3], +m[1] - 1, +m[2]);
  if (d.getMonth() !== +m[1] - 1 || d.getDate() !== +m[2]) return false;
  const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
  return age >= 18 && age < 120;
}

/**
 * Auto-mask a digit stream into M/D/YYYY — "7161994" → "7/16/1994",
 * "07161994" → "07/16/1994". On deletion, pass through so backspace works.
 */
export function obFmtDob(raw: string, prev?: string): string {
  if (prev && raw.length < prev.length) return raw;
  const ds = String(raw).replace(/\D/g, "").slice(0, 8);
  if (!ds) return "";
  let i = 0;
  let mm: string;
  let dd = "";
  let yy = "";
  if (ds[0] === "0" || ds[0] === "1") {
    const two = +ds.slice(0, 2);
    if (ds.length >= 2 && two >= 1 && two <= 12) {
      mm = ds.slice(0, 2);
      i = 2;
    } else {
      mm = ds[0];
      i = 1;
    }
  } else {
    mm = ds[0];
    i = 1;
  }
  if (i < ds.length) {
    const two = +ds.slice(i, i + 2);
    if (ds.length - i >= 2 && two >= 1 && two <= 31) {
      dd = ds.slice(i, i + 2);
      i += 2;
    } else if (+ds[i] >= 4 || ds.length - i === 1) {
      dd = ds[i];
      i += 1;
    } else {
      dd = ds.slice(i, i + 2);
      i += 2;
    }
  }
  yy = ds.slice(i, i + 4);
  return mm + (dd ? "/" + dd : "") + (yy ? "/" + yy : "");
}

/** "M/D/YYYY" (display) → "YYYY-MM-DD" (profiles.date_of_birth). Null when invalid. */
export function obDobToIso(dob: string): string | null {
  const m = String(dob).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** "YYYY-MM-DD" (profiles.date_of_birth) → "MM/DD/YYYY" (display). */
export function obDobFromIso(iso: string | null | undefined): string {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/* ── Profile strength — ONE model for the flow and the meter ──────────────── */

/** What each slot is worth (design spec: card 30 · plan 30 · household 10 ·
 *  ZIP 10 · DOB 5 · sex 5 · situation 10 = 100). */
export const OB_WEIGHTS = {
  card: 30,
  doc: 30,
  household: 10,
  zip: 10,
  dob: 5,
  sex: 5,
  situation: 10,
} as const;

/**
 * "Complete" threshold. The design mock said ≥90, but sex (+5) and situation
 * (+10) are OPTIONAL — a user who declines both tops out at 85 and would sit
 * in the partial checklist forever, which contradicts Q4 (declining is an
 * answer). Adopted (Andrew, S285): complete = every REQUIRED slot done = 85.
 */
export const OB_COMPLETE_THRESHOLD = 85;

export interface StrengthSlots {
  /** Card info on file — insurance-card doc OR a saved member ID. */
  card: boolean;
  /** Coverage doc on file — plan doc (SBC/EOC/booklet) OR bill/EOB. */
  doc: boolean;
  household: boolean;
  zip: boolean;
  dob: boolean;
  sex: boolean;
  situation: boolean;
}

export function obStrength(s: StrengthSlots): number {
  let total = 0;
  if (s.card) total += OB_WEIGHTS.card;
  if (s.doc) total += OB_WEIGHTS.doc;
  if (s.household) total += OB_WEIGHTS.household;
  if (s.zip) total += OB_WEIGHTS.zip;
  if (s.dob) total += OB_WEIGHTS.dob;
  if (s.sex) total += OB_WEIGHTS.sex;
  if (s.situation) total += OB_WEIGHTS.situation;
  return total;
}

/** Checklist rows for the meter's partial state (order = display order). */
export const OB_METER_ITEMS: {
  slot: keyof StrengthSlots;
  label: string;
  why: string;
  cta: string;
  /** /onboarding step the row deep-links to (1-based). */
  step: 1 | 2 | 3;
}[] = [
  { slot: "card", label: "Insurance card", why: "IDs + copays", cta: "Add card", step: 1 },
  { slot: "doc", label: "Plan document or bill", why: "arms audits", cta: "Add document", step: 2 },
  { slot: "household", label: "Who's on the plan", why: "family math", cta: "Answer", step: 3 },
  { slot: "zip", label: "ZIP code", why: "local rates", cta: "Add ZIP", step: 3 },
  { slot: "dob", label: "Date of birth", why: "required · 18+", cta: "Add", step: 3 },
  { slot: "sex", label: "Sex", why: "sex-specific benefits", cta: "Add", step: 3 },
  { slot: "situation", label: "What brings you here", why: "audit priority", cta: "Tell us", step: 3 },
];

/** One extracted/saved value rendered as a pill in the done-state cards. */
export interface ObChip {
  label: string;
  value: string;
  verified?: boolean;
  mono?: boolean;
}

/* ── Server-shape helpers ─────────────────────────────────────────────────── */

/** The GET /api/profile fields this feature reads (additive; older API bodies
 *  simply leave the booleans undefined → treated as false / legacy-complete). */
export interface OnboardingProfileShape {
  onboardingCompletedAt?: string | null;
  hasClaims?: boolean;
  hasCard?: boolean;
  hasPlanOrBill?: boolean;
  /** S286 additive: newest coverage docs (≤4) + exact total, for the doc-card restore. */
  recentCoverageDocs?: RecentCoverageDoc[];
  coverageDocCount?: number;
  /** S288: the active plan row — a catalog_match source fills the doc slot
   *  (search-select IS a substitute for uploading a document). */
  insurancePlan?: { source?: string | null } | null;
  profile?: {
    member_id?: string | null;
    insurer?: string | null;
    group_number?: string | null;
    household?: string | null;
    situation_tags?: string[] | null;
    primary_concern?: string | null;
    zip_code?: string | null;
    date_of_birth?: string | null;
    sex?: string | null;
  } | null;
}

/** Compute strength slots from the profile API response (single derivation —
 *  the flow and the meter must never disagree). */
export function slotsFromProfile(p: OnboardingProfileShape): StrengthSlots {
  const prof = p.profile;
  return {
    // S320 — a typed group number is card data too: the meter said "missing"
    // to a user who had just typed one (member ID absent, no scan doc).
    card: p.hasCard === true || !!prof?.member_id || !!prof?.group_number,
    // S288: a search-selected plan (catalog_match) IS the doc slot's substitute
    // — no more "Your audits can't run yet" after picking a plan from the library.
    doc: p.hasPlanOrBill === true || p.insurancePlan?.source === "catalog_match",
    household: !!prof?.household,
    zip: obZipOk(prof?.zip_code),
    dob: obDobOk(obDobFromIso(prof?.date_of_birth)),
    sex: !!prof?.sex,
    situation: (prof?.situation_tags?.length ?? 0) > 0,
  };
}

/**
 * Unwrap a possibly display-state-decorated value to its scalar. `/api/plan/analyze`
 * returns `DecoratedValue<T>` ({ value, state, reason, … }) for matched/active plans
 * (consumer-read Pattern P-8); the onboarding result chips need the raw scalar. Raw
 * (already-scalar) values pass through unchanged. Fixture-guarded — a decorated object
 * rendered directly as a React child crashes the flow (S286).
 */
export function unwrapDecorated<T>(x: unknown): T {
  return isDecoratedValue<T>(x) ? x.value : (x as T);
}

/** "$1,500" from a number-ish value; null when not a finite number. */
export function obFmtMoney(n: unknown): string | null {
  const v = typeof n === "number" ? n : typeof n === "string" ? parseFloat(n) : NaN;
  if (!isFinite(v)) return null;
  return `$${Math.round(v).toLocaleString()}`;
}

/* ── Result-chip builders — ONE shaping for live parses AND mount-restore ──
   (S286: the reload/restore path previously rebuilt the doc card generically —
   wrong kind, no filename, no chips. Both paths now share these.) */

/** Response slice of POST /api/plan/analyze the plan chips read. */
export interface PlanAnalyzeChipSource {
  totalBenefits?: number;
  planSummary?: { inDeductible?: unknown; inOopMax?: unknown; planType?: unknown } | null;
}

export function chipsFromPlanAnalyze(data: PlanAnalyzeChipSource): ObChip[] {
  const chips: ObChip[] = [];
  const ded = obFmtMoney(unwrapDecorated(data.planSummary?.inDeductible));
  const oop = obFmtMoney(unwrapDecorated(data.planSummary?.inOopMax));
  if (ded) chips.push({ label: "Deductible", value: ded, verified: true });
  if (oop) chips.push({ label: "OOP max", value: oop, verified: true });
  const planType = unwrapDecorated<string | null>(data.planSummary?.planType ?? null);
  if (planType) chips.push({ label: "Plan type", value: String(planType) });
  if (typeof data.totalBenefits === "number" && data.totalBenefits > 0) {
    chips.push({ label: "Covered services", value: `${data.totalBenefits} indexed` });
  }
  return chips;
}

/** Response slice of GET /api/claims?documentId= the bill chips read. */
export interface ClaimChipSource {
  lineItemCount?: number;
  findingCount?: number;
  providerName?: string | null;
  recovery?: { potentialRecovery?: number } | null;
}

export function chipsFromClaimSummary(claim: ClaimChipSource | null | undefined): ObChip[] {
  const chips: ObChip[] = [];
  if (!claim) return chips;
  const rec = obFmtMoney(claim.recovery?.potentialRecovery);
  if (rec) chips.push({ label: "Potential recovery", value: rec, verified: true });
  if (typeof claim.lineItemCount === "number") {
    chips.push({ label: "Line items", value: String(claim.lineItemCount) });
  }
  if (typeof claim.findingCount === "number") {
    chips.push({ label: "Findings", value: String(claim.findingCount) });
  }
  if (claim.providerName) chips.push({ label: "Provider", value: claim.providerName });
  return chips;
}

/** One row of GET /api/profile's `recentCoverageDocs` (S286 additive field). */
export interface RecentCoverageDoc {
  id: string;
  file_name: string | null;
  doc_type: string | null;
  status: string | null;
}
