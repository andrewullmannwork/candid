/**
 * case-events — emitter for the `claim_case_events` spine (mig 221).
 *
 * Timeline unification Phase 0 (S298; agenda §1 + §0.9e). Mutable rows stay
 * authoritative for CURRENT state; this ledger is authoritative for HISTORY +
 * SEQUENCE, emitted server-side at the existing mutation sites.
 *
 * Contract:
 *  - FAIL-SOFT: a missed event loses a history line, never corrupts state.
 *    Nothing here throws; errors are logged and swallowed. Callers MUST NOT
 *    await-gate their own success on an emit.
 *  - FLAG-GATED on `case_timeline_v1` (OFF = no writes, byte-identical).
 *  - PAYLOADS CARRY REFERENCES ONLY — version ordinals, step ids, finding
 *    types, from/to ids, `hasNote` booleans. Never money (display pulls live
 *    values from rows), never note/free text, never PHI. (Agenda §0.9e.)
 *  - Writes ride userScoped (B9) so user_id is stamped server-side and the
 *    raw-`.from()` lint backstop holds.
 *
 * The kind vocabulary is closed here (18, v1) — the DB shape-checks but does
 * not enumerate, so RESERVED kinds (case_closed, case_reopened,
 * complaint_filed, document_attached) are a code change when their emitter or
 * UI exists, not a migration.
 *
 * Emitter coverage: 18 of 18 kinds fire. `collection_resumed_reported` (S299
 * phase 1a) and `letter_downloaded` (S300 phase 2b — the download is a
 * client-side Blob, so it pings) both ride
 * POST /api/claims/[claimId]/case-events; everything else emits from the
 * mutation site that owns the write. The vocabulary is closed — a NEW kind
 * needs an emitter in the same change, never a declaration alone.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { userScoped } from "@/lib/security/user-scoped";

export const CASE_EVENT_KINDS = [
  // Letter lifecycle (per version; subsumes tracker Item N's lineage table)
  "letter_drafted",
  "letter_sent",
  "letter_unsent",
  "letter_redrafted",
  "letter_downloaded",
  // S312 (F2-S312.1) — the user withdrew a never-sent draft (status →
  // "cancelled"; the row becomes a read-only exhibit per the S308 void rule).
  // Its own kind: a dismissal is the user declining the letter, not an
  // outcome of sending one. Payload carries `reason` ("zero_demand" when the
  // no-remaining-demand banner prompted it, "user" otherwise) — flywheel
  // signal for WHY drafted letters die. Emitter: the dismiss route, same
  // change. No migration — mig 221 shape-checks `kind`. Count: 21 → 22.
  "letter_dismissed",
  // Waits + outcomes
  "response_logged",
  "outcome_undone",
  "deadline_lapsed",
  "followup_sent",
  // Track moves
  "escalated",
  "collections_reported",
  "collection_resumed_reported",
  // Guided steps (attested-only; checkedAt is the server stamp)
  "guide_step_attested",
  "guide_step_unchecked",
  // S301 — a step DISMISSED without doing it. Its own kind, never folded into
  // `guide_step_attested`: a skip is the user declining an action, and recording
  // it as an attestation would put a claim in the case record that the user
  // never made (S297 §3.2). No migration — mig 221 shape-checks `kind`
  // (`^[a-z0-9_]+$`) rather than enumerating it, precisely so the vocabulary can
  // grow in TS. Vocabulary count: 18 → 19.
  "guide_step_skipped",
  "phone_outcome_answered",
  // Case-basis changes the rows overwrite in place
  "plan_repinned",
  // S302 — the user adjudicated a bill whose line items did not sum to its own
  // summary. Belongs in THIS group ("case-basis changes the rows overwrite in
  // place") beside plan_repinned: it changes which numbers every downstream
  // derivation cites, and the claim row holds only the answer, not the history
  // of asking. Flywheel value: a bill is internally consistent on paper, so the
  // disagreement is always OURS — this is a human telling us WHICH of our two
  // parses was wrong, which is precision-oracle signal for parser calibration.
  // Payload is `{ chose }` ONLY: which fields disagreed is derivable from the
  // claim, and money amounts are excluded on principle (payload discipline).
  // No migration — mig 221 shape-checks `kind` rather than enumerating it,
  // exactly so the vocabulary grows in TS. Count: 19 → 20.
  "bill_totals_adjudicated",
  "finding_dismissed",
  "audit_rerun",
] as const;

export type CaseEventKind = (typeof CASE_EVENT_KINDS)[number];

export type CaseEventActor = "user" | "system" | "backfill";

export interface CaseEventInput {
  claimId: string;
  /** Null/omitted for claim-level events (phone steps, repins, audit reruns). */
  disputeId?: string | null;
  kind: CaseEventKind;
  /** Defaults to "user" — the overwhelmingly common emitter context. */
  actor?: CaseEventActor;
  /** ISO timestamp; omit to take the DB's now(). Backfill supplies row-derived times. */
  occurredAt?: string;
  /** REFERENCES ONLY — see module contract. */
  payload?: Record<string, unknown>;
}

/**
 * Emit one or more case events. One flag read, one insert round-trip.
 * Never throws; returns nothing — callers must not branch on emit success.
 */
export async function emitCaseEvents(
  supabase: SupabaseClient,
  userId: string,
  events: CaseEventInput[],
): Promise<void> {
  try {
    if (events.length === 0) return;
    if (!(await isFeatureEnabled("case_timeline_v1"))) return;
    const rows = events.map((e) => ({
      claim_id: e.claimId,
      dispute_id: e.disputeId ?? null,
      kind: e.kind,
      actor: e.actor ?? "user",
      payload: e.payload ?? {},
      ...(e.occurredAt ? { occurred_at: e.occurredAt } : {}),
    }));
    const { error } = await userScoped(supabase, userId)
      .table("claim_case_events")
      .insert(rows);
    if (error) {
      // 23505 = the backfill idempotency index absorbing a re-run — silence by
      // design; anything else is logged (fail-soft: history line lost, state intact).
      if (error.code !== "23505") {
        console.error(
          "[case-events] emit failed (fail-soft):",
          events.map((e) => e.kind).join(","),
          error,
        );
      }
    }
  } catch (err) {
    console.error("[case-events] emit threw (fail-soft):", err);
  }
}

/** Single-event convenience over emitCaseEvents. */
export async function emitCaseEvent(
  supabase: SupabaseClient,
  userId: string,
  event: CaseEventInput,
): Promise<void> {
  return emitCaseEvents(supabase, userId, [event]);
}
