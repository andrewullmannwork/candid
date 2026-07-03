/**
 * POST /api/disputes/[disputeId]/deadline-inputs — Dispute Letters v2 (Zone-1).
 *
 * Persists the two user-supplied deadline anchor dates onto the dispute:
 *   - denialNoticeDate          → anchors the ERISA 180-day internal-appeal window
 *   - collectorFirstContactDate → anchors the FDCPA 30-day debt-validation window
 *
 * Both land in dispute_outcomes.metadata (user-scoped) so they survive reload and
 * are threaded into /api/disputes/generate's deadline engine. The write is
 * intentionally NOT flag-gated — the dates persist regardless of
 * dispute_deadline_engine_v1; only the engine's *consumption* is gated, so the
 * anchors are ready the moment the flag flips ON. The dormant erisa_appeal_180
 * guard fires organically once denialNoticeDate is present (post-launch tracker §E).
 *
 * Body: { denialNoticeDate?: string | null, collectorFirstContactDate?: string | null }
 *   - "YYYY-MM-DD" (must be on or before today; both anchors are past-dated) sets it
 *   - null clears it; a key absent from the body is left unchanged
 * Auth: Firebase bearer token; verifies the user owns the dispute (IDOR).
 * Returns: { success: true, denialNoticeDate: string | null, collectorFirstContactDate: string | null }
 *
 * Mirrors confirm-patient-identity's dispute_outcomes.metadata spread-merge.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { evaluateDeadline, readDeadlineConfig } from "@/lib/disputes/deadline-engine";
import { isFeatureEnabled } from "@/lib/config/product-flags";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A deadline anchor is either null (clear) or a "YYYY-MM-DD" that is on or before
 * today. Future dates are rejected — both anchors record something that already
 * happened (a denial received, a collector's first contact). String comparison is
 * valid for YYYY-MM-DD ordering.
 */
function validateAnchor(
  value: unknown,
  todayIso: string,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !DATE_RE.test(value)) return { ok: false };
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t) || value > todayIso) return { ok: false };
  return { ok: true, value };
}

/** Resolve the letter type from a dispute row (metadata.letterType wins; else map dispute_type).
 *  Mirrors resolveLetterTypeFromDispute in the GET + redraft routes (kept local per that pattern). */
function resolveLetterType(dispute: {
  dispute_type: string;
  metadata?: Record<string, unknown> | null;
}): string {
  const metaType =
    dispute.metadata && typeof dispute.metadata === "object"
      ? (dispute.metadata as { letterType?: string }).letterType
      : undefined;
  if (metaType) return metaType;
  switch (dispute.dispute_type) {
    case "internal_appeal":
    case "external_appeal":
      return "insurance_appeal";
    case "negotiation":
      return "negotiation";
    case "complaint":
      return "balance_billing";
    default:
      return "overcharge";
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hasDenial = "denialNoticeDate" in body;
  const hasCollector = "collectorFirstContactDate" in body;
  if (!hasDenial && !hasCollector) {
    return NextResponse.json(
      { error: "Provide denialNoticeDate and/or collectorFirstContactDate" },
      { status: 400 },
    );
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  let denial: string | null | undefined;
  let collector: string | null | undefined;
  if (hasDenial) {
    const r = validateAnchor(body.denialNoticeDate, todayIso);
    if (!r.ok) {
      return NextResponse.json(
        { error: "denialNoticeDate must be YYYY-MM-DD on or before today, or null" },
        { status: 400 },
      );
    }
    denial = r.value;
  }
  if (hasCollector) {
    const r = validateAnchor(body.collectorFirstContactDate, todayIso);
    if (!r.ok) {
      return NextResponse.json(
        {
          error:
            "collectorFirstContactDate must be YYYY-MM-DD on or before today, or null",
        },
        { status: 400 },
      );
    }
    collector = r.value;
  }

  const { disputeId } = await params;
  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: dispute, error: fetchErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select("id, metadata, dispute_type, filed_date, governing_deadline_date")
    .eq("id", disputeId)
    .single();
  if (fetchErr || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  // Lost-update-safe: re-read metadata and spread-merge only the provided keys
  // (undefined = leave as-is; null = clear). Mirrors the confirm-* write pattern.
  const baseMetadata = (dispute.metadata as Record<string, unknown>) ?? {};
  const nextMetadata: Record<string, unknown> = { ...baseMetadata };
  if (denial !== undefined) nextMetadata.denialNoticeDate = denial;
  if (collector !== undefined) nextMetadata.collectorFirstContactDate = collector;
  nextMetadata.deadlineInputsUpdatedAt = new Date().toISOString();

  // dispute-letters v2 (Zone-2, A3) — when the deadline engine is ON, saving an anchor date also
  // computes + persists the governing deadline and (first time only) schedules the graduated
  // follow-up letters. Flag-gated so the governing columns are never referenced while OFF.
  const updatePayload: Record<string, unknown> = {
    metadata: nextMetadata,
    updated_at: new Date().toISOString(),
  };
  let scheduleDeadline:
    | { governingDeadlineDate: string; deadlineType: string; letterType: string }
    | null = null;
  const deadlineEngineOn = await isFeatureEnabled("dispute_deadline_engine_v1");
  if (deadlineEngineOn) {
    const letterType = resolveLetterType(
      dispute as { dispute_type: string; metadata?: Record<string, unknown> | null },
    );
    const config = await readDeadlineConfig(supabase);
    const dr = evaluateDeadline(
      {
        letterType,
        denialNoticeDate: (nextMetadata.denialNoticeDate as string | null) ?? null,
        collectorFirstContactDate: (nextMetadata.collectorFirstContactDate as string | null) ?? null,
      },
      config,
    );
    updatePayload.governing_deadline_date = dr.governingDeadlineDate;
    updatePayload.deadline_type = dr.deadlineType;
    // First-time scheduling only: the governing deadline was unset before this save. (Editing an
    // anchor later re-persists the columns but does NOT reschedule the rows — deferred, tracker §E.)
    const wasSet =
      (dispute as { governing_deadline_date?: string | null }).governing_deadline_date != null;
    if (dr.governingDeadlineDate && dr.deadlineType && !wasSet) {
      scheduleDeadline = {
        governingDeadlineDate: dr.governingDeadlineDate,
        deadlineType: dr.deadlineType,
        letterType,
      };
    }
  }

  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update(updatePayload)
    .eq("id", dispute.id);

  if (updateErr) {
    console.error("[deadline-inputs] update failed:", updateErr);
    return NextResponse.json(
      { error: "Failed to persist deadline inputs" },
      { status: 500 },
    );
  }

  // Schedule the graduated follow-up letters once (first time a governing deadline is set). Non-fatal:
  // the anchors + governing columns already persisted; a scheduling hiccup must not fail the save.
  if (scheduleDeadline) {
    try {
      const { createFollowups } = await import("@/lib/disputes/followups");
      await createFollowups(supabase, {
        disputeId: dispute.id,
        userId: user.id,
        letterType: scheduleDeadline.letterType,
        filedDate: (dispute as { filed_date?: string | null }).filed_date ?? undefined,
        deadline: {
          governingDeadlineDate: scheduleDeadline.governingDeadlineDate,
          deadlineType: scheduleDeadline.deadlineType,
        },
      });
    } catch (e) {
      console.error("[deadline-inputs] follow-up scheduling failed:", e);
    }
  }

  return NextResponse.json({
    success: true,
    denialNoticeDate:
      (nextMetadata.denialNoticeDate as string | null | undefined) ?? null,
    collectorFirstContactDate:
      (nextMetadata.collectorFirstContactDate as string | null | undefined) ?? null,
  });
}
