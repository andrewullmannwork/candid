/**
 * POST /api/claims/[claimId]/checklist — Guided Steps v1 (S297).
 *
 * Persists one guided-step attestation into `claims.metadata.guideSteps`:
 *   { [stepId]: { checkedAt: string | null, note?: string } }
 *
 * Mirrors the dispute checklist route's shape (same KEY_RE, same userScoped
 * ownership, foreign row → 404 anti-enum). Claim-scoped because Pack A′ is the
 * BILL's call log — shared by every letter on the bill, surviving escalation.
 *
 * Body: { stepId: string; checked?: boolean; note?: string } — at least one of
 * checked/note. `checked: true` stamps a SERVER-side timestamp (clients never
 * supply times — handoff §3.9); `checked: false` nulls it; `note` persists
 * independently of the checkbox (blur-save), capped short (v1 data ceiling:
 * checkbox + timestamp + one short note — no parsed dates, no engine writes).
 *
 * Auth: Firebase bearer token. Verifies user owns the claim (userScoped).
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { emitCaseEvents, type CaseEventInput } from "@/lib/case/case-events";

const KEY_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;
const NOTE_MAX = 500;

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    stepId?: unknown;
    checked?: unknown;
    skipped?: unknown;
    note?: unknown;
    disputeId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const stepId = typeof body.stepId === "string" ? body.stepId : null;
  /**
   * S303 — the letter this act answered, used ONLY to stamp the emitted ledger
   * event. Deliberately not persisted into guideSteps: for the regulator steps
   * the key already carries it, and storing it twice is two truths. Without it
   * the spine records "a complaint was filed" with no link to the letter it
   * followed, and the Case File would have to parse a step id to rebuild the
   * sequence. Additive and optional — every existing caller omits it.
   */
  const eventDisputeId =
    typeof body.disputeId === "string" && body.disputeId.length > 0 ? body.disputeId : null;
  const checked = typeof body.checked === "boolean" ? body.checked : null;
  const skipped = typeof body.skipped === "boolean" ? body.skipped : null;
  const note = typeof body.note === "string" ? body.note : null;
  if (checked === true && skipped === true) {
    return NextResponse.json(
      { error: "A step cannot be both checked and skipped" },
      { status: 400 },
    );
  }
  if (!stepId || !KEY_RE.test(stepId) || (checked == null && skipped == null && note == null)) {
    return NextResponse.json(
      {
        error:
          "Expected { stepId: string (1-64 chars), checked?: boolean, skipped?: boolean, note?: string } with at least one of checked/skipped/note",
      },
      { status: 400 },
    );
  }
  if (note != null && note.length > NOTE_MAX) {
    return NextResponse.json(
      { error: `note exceeds ${NOTE_MAX} characters` },
      { status: 400 },
    );
  }

  const { claimId } = await params;
  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // S309 F8 — the plain read-merge-write here LOST UPDATES under concurrent
  // requests: a note-blur save and a check click fire together, both handlers
  // read the same prior blob, and whichever commits last erases the other's
  // field (observed live: checkedAt gone while the spine said attested — and
  // the letter recital reads checkedAt). Fixed at the WRITE: compare-and-swap
  // on a metadata revision key (`metaRev`, inside the JSONB — no migration)
  // with re-read-re-merge retry. Serializes EVERY writer through this route
  // (GuidedPhoneSteps, CaseRail's runClaimStep, regulator doors, collections),
  // multi-tab included, no client cooperation needed. Cross-ROUTE metadata
  // writers (cost-share-override) are the named follow-up, not this fix.
  type GuideStep = {
    checkedAt: string | null;
    skippedAt?: string | null;
    note?: string;
    noteHistory?: Array<{ note: string; replacedAt: string }>;
  };
  const CAS_ATTEMPTS = 3;
  let claimRowId: string | null = null;
  let guideSteps: Record<string, GuideStep> = {};
  let next: GuideStep | null = null;
  for (let attempt = 1; attempt <= CAS_ATTEMPTS && claimRowId == null; attempt++) {
    const { data: claim, error: fetchErr } = await userScoped(supabase, user.id)
      .table("claims")
      .select("id, metadata")
      .eq("id", claimId)
      .single();
    if (fetchErr || !claim) {
      return NextResponse.json({ error: "Claim not found" }, { status: 404 });
    }

    const meta = (claim.metadata as Record<string, unknown>) ?? {};
    const priorRev = typeof meta.metaRev === "number" ? (meta.metaRev as number) : null;
    const steps: Record<string, GuideStep> = {
      ...((meta.guideSteps as Record<string, GuideStep> | undefined) ?? {}),
    };
    const prior = steps[stepId] ?? { checkedAt: null };
    const candidate: GuideStep = { ...prior };
    // S301 — THREE resolved states, kept mutually exclusive on write so no reader
    // has to decide which wins: done (checkedAt), skipped (skippedAt), open
    // (neither). A skip is the user declining the action, so it must never be
    // stored as, or rendered as, an attestation.
    if (checked === true) {
      candidate.checkedAt = new Date().toISOString();
      candidate.skippedAt = null;
    }
    if (checked === false) candidate.checkedAt = null;
    if (skipped === true) {
      candidate.skippedAt = new Date().toISOString();
      candidate.checkedAt = null;
    }
    if (skipped === false) candidate.skippedAt = null;
    if (note != null) {
      // S297 noteHistory (Andrew) — these logs are evidence; before replacing a
      // non-empty note with something different, bank the old value (last 5,
      // server-stamped) so an accidental delete is recoverable.
      const priorNote = typeof prior.note === "string" ? prior.note : null;
      if (priorNote != null && priorNote.length > 0 && priorNote !== note) {
        candidate.noteHistory = [
          ...(prior.noteHistory ?? []),
          { note: priorNote, replacedAt: new Date().toISOString() },
        ].slice(-5);
      }
      candidate.note = note;
    }
    steps[stepId] = candidate;

    let updateQ = userScoped(supabase, user.id)
      .table("claims")
      .update({
        metadata: { ...meta, guideSteps: steps, metaRev: (priorRev ?? 0) + 1 },
        updated_at: new Date().toISOString(),
      })
      .eq("id", claim.id);
    // The CAS guard: only land on the exact revision we merged from. A missing
    // key is the legacy state, matched with IS NULL and stamped by this write.
    updateQ =
      priorRev == null
        ? updateQ.is("metadata->>metaRev", null)
        : updateQ.eq("metadata->>metaRev", String(priorRev));
    const { data: updatedRows, error: updateErr } = await updateQ.select("id");

    if (updateErr) {
      console.error("[claim-checklist] update failed:", updateErr);
      return NextResponse.json(
        { error: "Failed to persist step" },
        { status: 500 },
      );
    }
    if ((updatedRows ?? []).length > 0) {
      claimRowId = claim.id as string;
      guideSteps = steps;
      next = candidate;
    }
    // 0 rows → another write landed between our read and write; loop re-reads
    // the fresh blob and re-applies THIS request's patch on top of it.
  }
  if (claimRowId == null || next == null) {
    return NextResponse.json(
      { error: "The claim changed while saving — please try again." },
      { status: 409 },
    );
  }

  // Timeline unification Phase 0 (S298, mig 221). The phone-outcome question
  // is its own kind; its yes/no answer is an ENUM riding `note` (S297), so it
  // may enter the payload — free-text notes never do (hasNote boolean only).
  // Note-only saves on ordinary steps are not attestations → no event.
  {
    const events: CaseEventInput[] = [];
    if (stepId === "packA:phone-outcome") {
      if (checked === false) {
        events.push({ claimId: claimRowId, kind: "guide_step_unchecked", payload: { stepId } });
      } else if (checked === true || note != null) {
        const answer =
          typeof next.note === "string" && ["yes", "no", "skip"].includes(next.note)
            ? next.note
            : null;
        events.push({
          claimId: claimRowId,
          kind: "phone_outcome_answered",
          payload: { stepId, answer },
        });
      }
    } else if (checked === true) {
      events.push({
        claimId: claimRowId,
        disputeId: eventDisputeId ?? undefined,
        kind: "guide_step_attested",
        payload: { stepId, hasNote: typeof next.note === "string" && next.note.length > 0 },
      });
    } else if (checked === false) {
      events.push({
        claimId: claimRowId,
        disputeId: eventDisputeId ?? undefined,
        kind: "guide_step_unchecked",
        payload: { stepId },
      });
    } else if (skipped === true) {
      // S301 — its own kind. The ledger records that the user DECLINED this
      // step; nothing downstream may read it as having been done.
      events.push({
        claimId: claimRowId,
        disputeId: eventDisputeId ?? undefined,
        kind: "guide_step_skipped",
        payload: { stepId },
      });
    } else if (skipped === false) {
      // Un-skipping returns the step to OPEN, not to done — same kind the
      // un-attest path uses, since both mean "this is unresolved again".
      events.push({
        claimId: claimRowId,
        disputeId: eventDisputeId ?? undefined,
        kind: "guide_step_unchecked",
        payload: { stepId },
      });
    }
    await emitCaseEvents(supabase, user.id, events);
  }

  return NextResponse.json({ guideSteps });
}
