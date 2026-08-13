/**
 * letter-type — THE resolver from a stored dispute row to its letter template.
 *
 * Single source (S298). Until this module, three private copies lived in the
 * [disputeId] GET, the redraft route, and the timeline projector — and the
 * first two had ALREADY drifted: on legacy rows (no metadata.letterType) the
 * GET mapped `complaint → balance_billing` / default → overcharge while
 * redraft mapped `complaint → overcharge` / default → insurance_appeal, so a
 * legacy complaint letter would change template on redraft. Dead code on
 * current data (every row since ~S109 stamps metadata.letterType at persist;
 * 0 unstamped rows in the DEV corpus) — but exactly the drift consolidation
 * exists to kill.
 *
 * Corrected here (Andrew, S298): legacy `external_appeal → external_review`.
 * The old GET guess (`insurance_appeal`) mistook the insurer track's TERMINAL
 * letter for its first rung — a denied legacy external review would be
 * offered "Start the next letter — external review", an escalation to the
 * letter it already is.
 *
 * Source of truth (newer rows): metadata.letterType, stamped at persist.
 * Legacy fallback: dispute_type → letter type, GET semantics + the fix.
 */
import type { DisputeLetterType, FindingType } from "@/lib/billing/types";
import { deadlineAnchorField } from "./deadline-engine";
import { deriveFindingToParties } from "./dispute-ground-catalog";

/**
 * Raw `dispute_outcomes.dispute_type` → resolved `DisputeLetterType`.
 *
 * ONE alias map, shared by `resolveLetterTypeFromDispute` (row → template) and
 * `letterRecipientKind` (type → recipient), because the two had already drifted:
 * the resolver mapped `external_appeal → external_review` (an INSURER letter)
 * while `letterRecipientKind` knew only the resolved name, so a raw
 * `external_appeal` fell through its lookup to the "provider" default. Callers
 * that pass `dispute.dispute_type` straight in — the [disputeId] GET and the
 * case-file route both do — were therefore scoring an insurer-directed external
 * review against a PROVIDER address it never prints (S301).
 */
const LEGACY_TYPE_ALIASES: Record<string, DisputeLetterType> = {
  internal_appeal: "insurance_appeal",
  external_appeal: "external_review",
  complaint: "balance_billing",
};

/** Resolve a raw dispute_type alias to its letter type; pass-through otherwise. */
export function normalizeLetterType(type: string): string {
  return LEGACY_TYPE_ALIASES[type] ?? type;
}

export function resolveLetterTypeFromDispute(dispute: {
  dispute_type: string;
  metadata?: Record<string, unknown> | null;
}): DisputeLetterType {
  const metaType =
    dispute.metadata && typeof dispute.metadata === "object"
      ? (dispute.metadata as { letterType?: string }).letterType
      : undefined;
  if (metaType) return metaType as DisputeLetterType;
  const alias = LEGACY_TYPE_ALIASES[dispute.dispute_type];
  if (alias) return alias;
  return dispute.dispute_type === "negotiation" ? "negotiation" : "overcharge";
}

// ── Recipient kind (MOVED here from index.ts, S301) ─────────────────────────
//
// Pure move + re-export from the barrel: every existing `letterRecipientKind`
// import site is unchanged. It lives here now because `letterNeeds` below is
// derived from it, and `letter-type.ts` is a leaf — deriving inside the
// `index.ts` barrel would drag templates/prior-contact/dispute-grounds into
// every consumer of the needs resolver and make the module graph circular
// (index → evidence-resolver → letter-type → index).
//
// EXHAUSTIVE over DisputeLetterType — the compiler forces every letter type to
// declare its recipient here, so a new type cannot silently fall through to
// "provider" (dispute-letters v2 S2 hardening).

export type LetterRecipientKind = "insurer" | "provider" | "collector";

const RECIPIENT_BY_LETTER_TYPE: Record<DisputeLetterType, LetterRecipientKind> = {
  overcharge: "provider",
  duplicate_charge: "provider",
  balance_billing: "provider",
  itemized_request: "provider",
  negotiation: "provider",
  insurance_appeal: "insurer",
  final_notice: "provider",
  external_review: "insurer",
  debt_validation: "collector",
};

// Raw dispute_outcomes.dispute_type values (NOT DisputeLetterType) that resolve to the insurer —
// the legacy rerender path passes these directly.
const INSURER_DISPUTE_TYPES = new Set<string>([
  "internal_appeal",
  "cost_share_misapplication",
  "coverage_contradiction",
  "not_covered",
]);

/**
 * S311 — the ONE department line each recipient kind's letters print.
 * templates.ts (the recipient-block builders) and the letter page's
 * ADDRESSED-TO card read this SAME map, so the card can never describe a
 * different envelope than the letter body (the S311 drive caught the card
 * saying "Billing Department" over a letter printing "Compliance
 * Department" — two inline strings for one envelope). Collector letters
 * print no department line and are deliberately absent.
 */
export const RECIPIENT_DEPARTMENT_LINE = {
  provider: "Compliance Department",
  insurer: "Appeals Department",
} as const;

export function letterRecipientKind(
  type: string | null | undefined,
): LetterRecipientKind {
  if (!type) return "provider";
  // Resolve legacy dispute_type aliases FIRST (S301) — callers pass whichever
  // they have, and `external_appeal` used to miss the lookup below and default
  // to "provider" on an insurer-directed letter.
  const resolved = normalizeLetterType(type);
  if (Object.prototype.hasOwnProperty.call(RECIPIENT_BY_LETTER_TYPE, resolved)) {
    return RECIPIENT_BY_LETTER_TYPE[resolved as DisputeLetterType];
  }
  return INSURER_DISPUTE_TYPES.has(resolved) ? "insurer" : "provider";
}

// ── letterNeeds (S301) — what THIS letter actually asks the user for ────────
//
// DERIVED, never authored. The letter composer already declares which address
// each letter prints (index.ts `recipient`: insurer → appealsAddress,
// collector → collector.address, otherwise → provider.address) and templates.ts
// carries one recipient-block builder per kind. This function is the machine
// image of that decision, so it cannot disagree with the letter it describes —
// a hand-maintained requirements table is the version someone forgets to
// update when a tenth letter type lands.
//
// Fixes the one-root defect family (S299/S300 defects #2/#3/#4 + the two this
// audit found): the gap emitter and the MVDL readiness floor both re-derived
// the recipient with `letterType !== "insurance_appeal"`, so every non-appeal
// letter — including insurer-directed external reviews and collector-directed
// debt validations — was asked for a PROVIDER address it never prints, while
// external reviews were never asked for the appeals address they do.
//
// ⚠ null letterType → NO address requirement. Today's binary guarded on
// `letterType !== null`, and `letterRecipientKind(null)` defaults to
// "provider" — so routing a null straight through the resolver would newly
// demand a provider address on every letterType-less call. Handled before the
// resolver, asserted in the fixture.

/**
 * S304 — the letter TRACKS a claim warrants, one per obligated party.
 *
 * An insurer appeal and a provider dispute are PARALLEL, not an escalation
 * ladder: the insurer paying $0 on a covered service and the provider's own
 * arithmetic not closing are independent wrongs against independent parties,
 * both valid at once. The escalation machinery (nextRungStillOpen, the 409
 * rung-already-taken gate) governs SEQUENTIAL rungs within one track and is
 * untouched by this — a first letter on a new track is not an escalation.
 */
export interface LetterTrack {
  party: "insurer" | "provider";
  /** Why the track exists. Distinct sources, so a rung can say what it rests on. */
  basis: "obligated_finding" | "insurer_underpaid" | "provider_overpaid";
  /**
   * S305 — the template this track's FIRST letter renders.
   *
   * Not a per-party constant: a `balance_billing` finding obligates the
   * provider AND has its own provider-directed template, so hardcoding
   * `provider → overcharge` would silently downgrade the letter the fallback
   * picks today. Derived instead by running the SHIPPED dominant-type
   * heuristic over this party's own findings — one template heuristic, not a
   * second one invented here — and falling to the party default whenever that
   * heuristic lands on a template addressed to somebody else.
   */
  letterType: DisputeLetterType;
}

const FINDING_TO_PARTIES = deriveFindingToParties();

/**
 * The letter a track falls back to when its findings name no template of their
 * own. `overcharge` and `insurance_appeal` are the first-contact rungs of the
 * two tracks (escalate-gate's `isFirstContactLetterType`).
 */
const PARTY_DEFAULT_LETTER: Record<LetterTrack["party"], DisputeLetterType> = {
  insurer: "insurance_appeal",
  provider: "overcharge",
};

/**
 * Dominant finding type wins; mixed falls back to insurance_appeal.
 *
 * MOVED here from ClaimDetail (S305), where it was a private function inside a
 * UI component deciding which legal template a letter renders. It has two
 * consumers now — the single-letter fallback and the per-track derivation
 * below — and both must pick templates the same way or the rung offers one
 * letter while the fallback drafts another.
 */
export function letterTypeHintFromTypes(types: readonly string[]): DisputeLetterType {
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  const dominantType = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (!dominantType) return "insurance_appeal";
  if (dominantType === "balance_billing") return "balance_billing";
  if (dominantType === "duplicate") return "duplicate_charge";
  if (dominantType === "overcharge") return "overcharge";
  return "insurance_appeal";
}

/**
 * The template for ONE track, from the findings that obligate THAT party.
 *
 * The recipient test is what makes this safe: `unallocated_balance` is not in
 * the heuristic's table, so it yields `insurance_appeal` — an INSURER template
 * on a provider track. Rather than special-casing the finding, the mismatch
 * itself is the signal to fall to the party default.
 */
function letterTypeForTrack(
  party: LetterTrack["party"],
  findingTypes: readonly string[],
): DisputeLetterType {
  const own = findingTypes.filter((t) =>
    (FINDING_TO_PARTIES[t as FindingType] ?? []).includes(party),
  );
  const hint = letterTypeHintFromTypes(own);
  return letterRecipientKind(hint) === party ? hint : PARTY_DEFAULT_LETTER[party];
}

/**
 * Which parties this claim has evidence against.
 *
 * TWO sources, both already computed elsewhere — nothing here is authored:
 *
 *  - `findingTypes` → the catalog's CURATED `obligationElements[].party`. Not
 *    `autoLetterType`, which is a per-ground template default and routes three
 *    insurer findings to the provider.
 *  - `insurerUnderpaid` → the cost-share engine's `InsurerDiscrepancy`
 *    ("positive = insurer assigned the patient MORE than the plan says"). This
 *    is NOT a finding and never will be — it comes from plan math, which is why
 *    a claim can warrant an appeal with zero audit findings against it.
 *
 * Returns EMPTY when neither source speaks. That is the common case — the
 * commonest finding, `overcharge`, has no obligated party by design — and the
 * caller must fall back to its existing behaviour rather than treat empty as
 * "no letter". Empty is also what a `recovery_cost_share_v2`-OFF claim yields,
 * since the insurer signal is gated on that flag; falling back keeps flag-off
 * behaviour byte-identical.
 */
export function deriveLetterTracks(input: {
  findingTypes: readonly string[];
  insurerUnderpaid: boolean;
  /** S309 F17 — the user paid above what the bill charged (derived from the
   *  effective totals; the Z1.1d paid overlay). Raises the PROVIDER track the
   *  same way insurerUnderpaid raises the insurer one: engine math, not a
   *  finding. Optional so existing callers are byte-identical. */
  providerOverpaid?: boolean;
}): LetterTrack[] {
  const parties = new Map<LetterTrack["party"], LetterTrack["basis"]>();

  for (const t of input.findingTypes) {
    for (const p of FINDING_TO_PARTIES[t as FindingType] ?? []) {
      // `provider_financial_assistance` is an inert render key (the charity/FA
      // fast-follow slot), not a letter recipient — never a track.
      if (p === "insurer" || p === "provider") parties.set(p, "obligated_finding");
    }
  }

  // An obligated finding is the stronger basis, so it is not overwritten.
  if (input.insurerUnderpaid && !parties.has("insurer")) {
    parties.set("insurer", "insurer_underpaid");
  }
  if (input.providerOverpaid && !parties.has("provider")) {
    parties.set("provider", "provider_overpaid");
  }

  // Stable order: the insurer track reads first because its deadline is the one
  // that expires (plan appeal windows), while a provider billing dispute has no
  // statutory clock.
  const order: Array<LetterTrack["party"]> = ["insurer", "provider"];
  return order
    .filter((p) => parties.has(p))
    .map((p) => ({
      party: p,
      basis: parties.get(p)!,
      letterType: letterTypeForTrack(p, input.findingTypes),
    }));
}

export type RecipientAddressGapKind =
  | "provider_address_missing"
  | "insurer_address_missing"
  | "collector_address_missing";

export type LetterNeedKey =
  | "provider_address"
  | "insurer_appeals_address"
  | "collector_address"
  | "collector_first_contact_date"
  | "account_number"
  | "denial_date"
  | "eob_detail";

export interface LetterNeeds {
  /** Who this letter mails to. Null only when no letter type is resolved yet. */
  recipientKind: LetterRecipientKind | null;
  /** The ONE address this letter prints — the MVDL floor item (§1b #3). */
  recipientAddress: LetterNeedKey | null;
  /** The gap kind that reports that address missing. Null → no address floor. */
  recipientAddressGapKind: RecipientAddressGapKind | null;
  /** Every track-VARYING row this letter shows, address included, in render order. */
  needs: readonly LetterNeedKey[];
}

/**
 * The gap kind that reports THIS recipient's address missing. One source, shared
 * by `letterNeeds` (which drives what the panel asks for) and the MVDL readiness
 * floor (which decides whether a missing address blocks sending) — so the address
 * we ask for and the address we score are the same address, by construction.
 */
export function recipientAddressGapKindFor(
  kind: LetterRecipientKind,
): RecipientAddressGapKind {
  switch (kind) {
    case "insurer":
      return "insurer_address_missing";
    case "collector":
      return "collector_address_missing";
    case "provider":
      return "provider_address_missing";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

const NO_NEEDS: LetterNeeds = {
  recipientKind: null,
  recipientAddress: null,
  recipientAddressGapKind: null,
  needs: [],
};

/**
 * What this letter needs from the user, keyed on the recipient it mails to.
 *
 * Universal rows (patient name, services performed, amount paid) are NOT listed
 * — they never vary by letter type, so the panel always renders them and this
 * resolver stays about what actually differs.
 *
 * `denial_date` is `insurance_appeal` ONLY. Its sole functional consumer is the
 * deadline engine's `erisa_appeal_180`, whose own INSURER_TRACK is
 * `["insurance_appeal"]`; no template reads it (external_review's denial date is
 * a DIFFERENT field — `appealExhausted.denialDate`, captured by the exhaustion
 * attestation). Asking for it on final_notice / external_review, as the panel
 * does today, is a dead ask nothing consumes.
 */
export function letterNeeds(letterType: string | null | undefined): LetterNeeds {
  if (!letterType) return NO_NEEDS;
  // Normalize before the denial_date test below — callers legitimately pass a
  // raw `dispute_type`, and `internal_appeal` IS an insurance_appeal.
  const resolved = normalizeLetterType(letterType);
  const recipientKind = letterRecipientKind(resolved);

  // The date ask is DERIVED from the deadline engine's anchor, not authored
  // here: a letter needs a date exactly when the engine computes a window from
  // it. That is what removes the dead denial-date ask on final_notice /
  // external_review, and it means adding a type to a deadline track moves the
  // ask with it instead of leaving two lists to drift.
  const anchor = deadlineAnchorField(resolved);
  const dateAsk: LetterNeedKey[] =
    anchor === "denialNoticeDate"
      ? ["denial_date"]
      : anchor === "collectorFirstContactDate"
        ? ["collector_first_contact_date"]
        : [];

  switch (recipientKind) {
    case "insurer":
      return {
        recipientKind,
        recipientAddress: "insurer_appeals_address",
        recipientAddressGapKind: recipientAddressGapKindFor(recipientKind),
        needs: ["insurer_appeals_address", ...dateAsk, "eob_detail"],
      };
    case "collector":
      // No eob_detail: the EOB adds the insurer paid/allowed side, which a
      // debt-validation letter never argues from.
      return {
        recipientKind,
        recipientAddress: "collector_address",
        recipientAddressGapKind: recipientAddressGapKindFor(recipientKind),
        needs: ["collector_address", ...dateAsk, "account_number"],
      };
    case "provider":
      return {
        recipientKind,
        recipientAddress: "provider_address",
        recipientAddressGapKind: recipientAddressGapKindFor(recipientKind),
        needs: ["provider_address", ...dateAsk, "eob_detail"],
      };
    default: {
      const _exhaustive: never = recipientKind;
      return _exhaustive;
    }
  }
}

// ── Letter display semantics (S299) — labels + the ONE letter-date rule ─────
//
// LETTER_TYPE_LABELS moved here from the disputes page (page-local since the
// v2 build) so the case rail and the dispute page share one label source —
// the same drift class the resolver consolidation above killed.
//
// Date rule (S286 formatFiledDate, promoted repo-wide at S299): date-only
// strings ("2026-09-29" — governing deadlines, resolution dates) pin to LOCAL
// midnight (UTC-midnight parsing renders the PREVIOUS day in US timezones);
// full ISO timestamps (sent_at, outcomeReportedAt) parse natively and land on
// the user's LOCAL calendar. Calendar math is CLIENT-side only — a server
// computes calendars in ITS timezone (UTC on Vercel), which is exactly how
// the rail said "sent Jul 31" while the dispute page said "sent Jul 30" for
// the same send (S299 E2E catch, Andrew).

export const LETTER_TYPE_LABELS: Record<DisputeLetterType, string> = {
  insurance_appeal: "Appeal to Insurer",
  overcharge: "Billing Dispute",
  balance_billing: "Balance Billing Dispute",
  duplicate_charge: "Duplicate Charge Dispute",
  itemized_request: "Itemized Bill Request",
  negotiation: "Self-Pay Negotiation",
  final_notice: "Final Notice",
  external_review: "External Review Request",
  debt_validation: "Debt Validation",
};

/** The one parse rule: date-only → LOCAL midnight; timestamps → native. */
export function parseLetterDate(iso: string): Date | null {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00`) : Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

/** "Sep 29" — the case rail's short date label. */
export function formatLetterDateShort(iso: string): string {
  const d = parseLetterDate(iso);
  if (!d) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Local start-of-day in ms (DST-safe via setHours). */
function startOfLocalDay(d: Date): number {
  const c = new Date(d.getTime());
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

/** Local-calendar days since `iso` (0 = same local day, 1 = yesterday). */
export function daysSinceLocal(iso: string, now: Date): number | null {
  const d = parseLetterDate(iso);
  if (!d) return null;
  return Math.round((startOfLocalDay(now) - startOfLocalDay(d)) / 86_400_000);
}

/** Local-calendar days until `iso` (0 = today; negative = passed). */
export function daysUntilLocal(iso: string, now: Date): number | null {
  const d = parseLetterDate(iso);
  if (!d) return null;
  return Math.round((startOfLocalDay(d) - startOfLocalDay(now)) / 86_400_000);
}

/** "2026-07-30" — the LOCAL calendar date of a timestamp (payload-safe form). */
export function toLocalDateOnly(iso: string): string {
  const d = parseLetterDate(iso);
  if (!d) return iso.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * S306 (UX-2) — the patient identity answer, as the letter composes it.
 * Persisted by confirm-patient-identity onto dispute.metadata.
 */
export interface LetterPatientIdentity {
  choice: "me" | "dependent" | "wrong";
  correctedName: string | null;
}

/**
 * S306 — THE letter patient name. One derivation for the name every template
 * prints as the patient, shared by the server compose (rerender) and the
 * compose-basis hash so the two can never watch different fields.
 *
 * Before this there were THREE mechanisms: the server's account-holder default
 * (pickPatientName, tracker AS), a CLIENT-side body substitution (S294
 * name-fill) whose "dependent" branch assumed the body carried the bill's name
 * when the server always rendered the account holder's — a silent no-op — and
 * a hash watching a key (attestingAsName) the compose never read for this.
 *
 *   "me"        → the account holder's name (their explicit confirmation)
 *   "dependent" → the bill's own patient name (the dependent)
 *   "wrong"     → the corrected name the user typed
 *   unanswered  → the account-holder default, UNCHANGED (tracker AS: Andrew's
 *                 S305 ruling covers the silent case; an explicit answer is a
 *                 different act and is honored)
 *
 * Every branch falls back to the default rather than an empty string — a
 * missing corrected name or blank bill name must never blank a legal letter.
 */
export function letterPatientName(
  identity: LetterPatientIdentity | null | undefined,
  billPatientName: string | null | undefined,
  accountHolderDefault: string,
): string {
  const bill = (billPatientName ?? "").trim();
  if (identity) {
    if (identity.choice === "me") return accountHolderDefault || bill;
    if (identity.choice === "dependent") return bill || accountHolderDefault;
    if (identity.choice === "wrong") {
      const corrected = (identity.correctedName ?? "").trim();
      return corrected || accountHolderDefault || bill;
    }
  }
  return accountHolderDefault || bill;
}

/**
 * Default to the account holder's name (from users.display_name); fall back
 * to bill-parsed name only when account name is unavailable. The UI surfaces
 * a banner when these differ so the user can edit before sending.
 * (Tracker AS's account-holder rule. Moved here from rerender.ts at S307 —
 * tracker AT — so the [disputeId] GET can compute the SAME default the
 * compose uses without importing the heavy rerender module.)
 */
export function pickPatientName(billName: string | null | undefined, profileName: string): string {
  if (profileName) return profileName;
  const trimmed = (billName ?? "").trim();
  if (!trimmed) return "";
  if (/^(patient|member|subscriber|insured|name)$/i.test(trimmed)) return "";
  if (/^\[.+\]$/.test(trimmed)) return "";
  return trimmed;
}

/** Read the persisted identity answer off dispute metadata (null = unanswered). */
export function letterPatientIdentityFromMeta(
  meta: Record<string, unknown> | null | undefined,
): LetterPatientIdentity | null {
  const choice = meta?.patientIdentityChoice;
  if (choice !== "me" && choice !== "dependent" && choice !== "wrong") return null;
  const corrected = meta?.patientCorrectedName;
  return {
    choice,
    correctedName: typeof corrected === "string" && corrected.trim() ? corrected.trim() : null,
  };
}

/**
 * S308 — is this letter status a LIVE DOCUMENT (UX-2: "a draft letter is a
 * live document; a sent letter is a record")? Only a live draft may be
 * recomposed-and-rewritten by the view/redraft paths. Deliberately a
 * fail-closed whitelist: every other status — cancelled (void; the S306
 * corpse family), the resolved family (won/lost/settled/withdrawn/escalation
 * variants), filed/in_progress (sent-era) — freezes the stored body, so a
 * future status word defaults to frozen, never to rewritable. The S308 E2E
 * caught a cancelled draft rebuilding on view because the rebuild gate
 * consulted only sent_at; status is the axis sent_at cannot see.
 */
export function isLiveDraftStatus(status: string | null | undefined): boolean {
  return status === "dispute_letter_drafted";
}

/**
 * S312 (Andrew: "shouldn't the letter auto-redraft?") — the letter COMPOSE
 * VERSION: a stamp for the letter-composition contract itself, hashed into the
 * UNSENT compose basis (evidence-fingerprint.ts) so that shipping a letter
 * improvement drifts every live draft exactly once — the same self-heal-on-view
 * rollout the drift watch already runs for data changes. A user never needs to
 * know the Re-draft button exists to receive a better letter.
 *
 * SENT letters can never see this: their fingerprint is evidence-only by the
 * standing shape rule, so a bump cannot fire the "your numbers have changed"
 * note on a mailed record (pinned in draft-live-rebuild).
 *
 * ⚠ BUMP DISCIPLINE: bump this in the SAME commit whenever letter compose
 * OUTPUT changes — the detector is the golden corpus: if golden pins
 * re-baseline (`golden-corpus.ts --update`), this bumps. Flag states decide
 * the delivery: live-rebuild ON → silent rebuild on next view; OFF (PROD at
 * promote) → the stale banner + Refresh consent flow. Value is opaque to the
 * hash — keep it readable for debugging.
 */
export const LETTER_COMPOSE_VERSION = "s312.1";

/**
 * S312 (T4, Andrew's ruling) — the ONE lifecycle word a letter surface may
 * print. The hero's eyebrow had "· DRAFT" BAKED into every letter-type string
 * (no status axis at all), so cancelled letters — and sent ones — wore "DRAFT"
 * forever. Vocabulary: DRAFT (live draft) · SENT (mailed — outcome chips
 * elsewhere carry the rest) · CANCELLED (withdrawn) · CLOSED (the rare
 * resolved-without-ever-sending exhibit, the S308 void family's other member).
 * Order matters: a cancelled letter has null sent_at, and a resolved letter
 * keeps its sent_at — status is the axis sent_at cannot see (S308).
 */
export function letterStateWord(
  status: string | null | undefined,
  sentAt: string | Date | null | undefined,
): "DRAFT" | "SENT" | "CANCELLED" | "CLOSED" {
  if (status === "cancelled") return "CANCELLED";
  if (sentAt != null) return "SENT";
  // S312 audit — sent-ERA statuses (persist.ts vocabulary: mark-as-sent writes
  // "filed"; the follow-up era runs "in_progress") with a null sent_at are
  // LEGACY sent rows from before the stamp existed — the letter page's own
  // "Sent {date}" readout falls back to filed_date for exactly these rows.
  // They read SENT, never CLOSED. Outcome statuses (won/lost/settled/withdrawn)
  // without a send stamp stay CLOSED: an outcome on a never-sent letter is the
  // resolved-unsent exhibit (S308/FIX-3), not a mailing.
  if (status === "filed" || status === "in_progress") return "SENT";
  return isLiveDraftStatus(status) ? "DRAFT" : "CLOSED";
}

/**
 * S312 (F2-S312.1) — should a ROW-reading surface offer the "this letter may no
 * longer be needed" banner (Dismiss / Keep)?
 *
 * The row-truth twin of the letter GET's live signal: the GET computes
 * `noRemainingLetterDemand` fresh from the fold and STAMPS the outcome onto
 * `metadata.noRemainingDemand` (the same self-heal write family that floats
 * `amount_disputed`), so row readers — the case projector → the rail — share
 * one persisted fact instead of re-deriving letter money. The stamp is only
 * ever written under `dispute_draft_live_rebuild_v1`, so its very existence
 * carries the flag: OFF in PROD ⇒ no stamps ⇒ every surface silent.
 *
 * `zeroDemandKeptAt` is the user's standing "Keep letter" answer — durable by
 * design (if dollars return, the GET re-stamps `noRemainingDemand: false` and
 * the condition is false anyway; no clearing machinery).
 */
export function zeroDemandDismissible(
  status: string | null | undefined,
  sentAt: string | Date | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const m = metadata ?? {};
  return (
    isLiveDraftStatus(status) &&
    sentAt == null &&
    m.noRemainingDemand === true &&
    !m.zeroDemandKeptAt
  );
}
