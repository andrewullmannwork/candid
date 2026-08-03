/**
 * load-case-timeline — the ONE server-side projection loader (S299 phase 2a).
 *
 * Agenda §1: "claim GET and dispute GET read ONLY the projector — this is the
 * one-derivation enforcement point." Phase 1a built this inline in the claim
 * GET; phase 2a extracts it so the dispute GET (the letter page's breadcrumb +
 * step identity + insurer names) consumes the IDENTICAL load — two callers,
 * one derivation, no drift.
 *
 * Flag-gated on `case_rail_v1` (returns null when OFF → byte-identical
 * payloads). history[] is omitted until phase 2b renders it — events are
 * still fetched so per-letter send/unsend counts are true. Fail-soft: a
 * projection failure returns null, never takes down the caller's page.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";
import { isFeatureEnabled, readFeatureFlagConfig } from "@/lib/config/product-flags";
import {
  projectCaseTimeline,
  type ProjectedCaseTimeline,
  type ProjectorDisputeRow,
  type ProjectorEventRow,
} from "@/lib/case/timeline-projector";

/**
 * The full projection + the display names resolved alongside it. SERVER-side
 * consumers (S300: the prior-contact recital) read this; the client payload
 * below is a narrowing of it. One load, two shapes — the alternative was a
 * second query for history, which is exactly the drift this loader exists to
 * prevent.
 */
export interface CaseProjection {
  projected: ProjectedCaseTimeline;
  insurerNameByDispute: Record<string, string>;
  providerName: string | null;
}

/** The full ProjectorDisputeRow column set (+ the pinned plan for names). */
export const CASE_TIMELINE_DISPUTE_COLUMNS =
  "id, claim_id, dispute_type, status, created_at, filed_date, resolution_date, sent_at, governing_deadline_date, deadline_type, metadata, insurance_plan_id";

export async function loadCaseProjection(
  supabase: SupabaseClient,
  userId: string,
  claimId: string,
  opts: {
    /** Pass when the caller already holds the claim row (id/created_at/metadata). */
    claimRow?: { id: string; created_at: string; metadata: Record<string, unknown> | null };
    /** Pass when the caller already fetched the dispute rows (full column set). */
    disputeRows?: Array<Record<string, unknown>>;
  } = {},
): Promise<CaseProjection | null> {
  try {
    if (!(await isFeatureEnabled("case_rail_v1"))) return null;

    let disputes = opts.disputeRows ?? null;
    if (!disputes) {
      const { data, error } = await userScoped(supabase, userId)
        .table("dispute_outcomes")
        .select(CASE_TIMELINE_DISPUTE_COLUMNS)
        .eq("claim_id", claimId);
      if (error) {
        console.error("[case-timeline] dispute load failed; projection omitted:", error);
        return null;
      }
      disputes = (data ?? []) as Array<Record<string, unknown>>;
    }
    if (disputes.length === 0) return null;

    let claimRow = opts.claimRow ?? null;
    if (!claimRow) {
      const { data, error } = await userScoped(supabase, userId)
        .table("claims")
        .select("id, created_at, metadata")
        .eq("id", claimId)
        .single();
      if (error || !data) {
        console.error("[case-timeline] claim load failed; projection omitted:", error);
        return null;
      }
      claimRow = {
        id: data.id as string,
        created_at: data.created_at as string,
        metadata: (data.metadata as Record<string, unknown> | null) ?? null,
      };
    }

    const { data: eventRows, error: eventsError } = await userScoped(supabase, userId)
      .table("claim_case_events")
      .select("dispute_id, kind, actor, occurred_at, payload")
      .eq("claim_id", claimId)
      .order("occurred_at", { ascending: true });
    if (eventsError) {
      console.error("[case-timeline] events load failed; projecting from rows only:", eventsError);
    }
    const amberDays = await readFeatureFlagConfig(
      "guided_steps_v1",
      "sent_countdown_amber_days",
      7,
    );
    const projected = projectCaseTimeline({
      claim: claimRow,
      disputes: disputes as unknown as ProjectorDisputeRow[],
      events: (eventRows ?? []) as ProjectorEventRow[],
      now: new Date(),
      amberDays,
    });

    // Wait titles + the letter page's counterparty need insurer display
    // names — resolved from each letter's PINNED plan (dispute_plan_pinning).
    // Unpinned rows / load failures fall back to "your plan" client-side.
    const insurerNameByDispute: Record<string, string> = {};
    const planIds = Array.from(
      new Set(
        disputes
          .map((d) => d.insurance_plan_id)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    );
    if (planIds.length > 0) {
      const { data: planRows, error: planError } = await userScoped(supabase, userId)
        .table("insurance_plans")
        .select("id, insurer_name")
        .in("id", planIds);
      if (planError) {
        console.error("[case-timeline] pinned-plan insurer load failed; titles fall back:", planError);
      }
      const insurerByPlan = new Map(
        (planRows ?? []).map((p) => [p.id as string, p.insurer_name as string | null]),
      );
      for (const d of disputes) {
        const planId = d.insurance_plan_id;
        const name = typeof planId === "string" ? insurerByPlan.get(planId) : null;
        if (typeof name === "string" && name.length > 0) {
          insurerNameByDispute[d.id as string] = name;
        }
      }
    }

    // The letter page's breadcrumb ("Part of your «provider» case") — same
    // metadata path claim-matching uses.
    const providerName =
      (((claimRow.metadata ?? {}).provider as Record<string, unknown> | undefined)
        ?.name as string | undefined) ?? null;

    return { projected, insurerNameByDispute, providerName };
  } catch (err) {
    console.error("[case-timeline] projection failed; omitted:", err);
    return null;
  }
}

/**
 * The CLIENT payload — a narrowing of {@link loadCaseProjection}. `history` is
 * deliberately NOT sent: no client surface renders it today, and shipping the
 * full event list on every claim GET would grow the response for nobody.
 * Server consumers that need it call loadCaseProjection directly.
 */
export async function loadCaseTimelinePayload(
  supabase: SupabaseClient,
  userId: string,
  claimId: string,
  opts: {
    claimRow?: { id: string; created_at: string; metadata: Record<string, unknown> | null };
    disputeRows?: Array<Record<string, unknown>>;
  } = {},
): Promise<Record<string, unknown> | null> {
  const loaded = await loadCaseProjection(supabase, userId, claimId, opts);
  if (!loaded) return null;
  const { projected, insurerNameByDispute, providerName } = loaded;
  return {
    letters: projected.letters,
    waitingCount: projected.waitingCount,
    soonestResponseDue: projected.soonestResponseDue,
    sentLetterMeta: projected.sentLetterMeta,
    insurerNameByDispute,
    providerName,
  };
}
