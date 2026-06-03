/**
 * Admin GET/POST for /admin/canonical-quality (Ing-D.0e, S160).
 *
 * Observability for the CF-40 v4 Layer-3/Layer-4 outputs — the surface that GATES the
 * Ing-D.1 admin-only soak (the queues admin must action once the flag flips ON). All
 * tables are EMPTY in PROD today (cf40_v4_algorithm OFF); the page is the scaffold
 * that populates during the staged rollout.
 *
 *   GET ?view=promotion       → canonical_doctype_promotion_state (filter promoted/doc_type)
 *   GET ?view=invalidation    → canonical_invalidation_events (pending) + canonical_drift_events (telemetry)
 *   GET ?view=divergence      → canonical_divergence_review (pending minority/rapid-change queue)
 *
 *   POST { target:'divergence', id, status, divergence_type, admin_notes? }
 *   POST { target:'invalidation', id, status }   // status → admin_disposition
 *
 * Disposition is TRIAGE-ONLY (Ing-D.0e MVP): it sets the row's admin verdict +
 * classification; it does NOT mutate any canonical (no auto re-baseline / un-promote).
 * Canonical-state changes stay with the Layer-4 detectors (automated) or a future
 * admin manual-invalidation action (Phase 2+).
 *
 * Auth: admin-only via Firebase ID token → users.is_admin. Mirrors
 * /api/admin/canonical-match-decisions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

async function requireAdmin(req: NextRequest): Promise<
  | { ok: true; supabase: ReturnType<typeof createServerClient>; adminUserId: string }
  | { ok: false; response: NextResponse }
> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: user } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user?.is_admin) {
      return { ok: false, response: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
    }
    return { ok: true, supabase, adminUserId: user.id as string };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid token" }, { status: 401 }) };
  }
}

type View = "promotion" | "invalidation" | "divergence";

const DISPOSITION_STATUSES = ["confirmed", "rejected", "deferred"] as const;
const DIVERGENCE_TYPES = [
  "possible_plan_variant",
  "possible_adversarial",
  "possible_stale_doc",
  "possible_haiku_noise",
  "unclassified",
] as const;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { supabase } = auth;
  const view = (req.nextUrl.searchParams.get("view") ?? "promotion") as View;

  if (view === "promotion") {
    const promotedParam = req.nextUrl.searchParams.get("promoted"); // 'true' | 'false' | null
    const docType = req.nextUrl.searchParams.get("doc_type"); // optional
    let q = supabase
      .from("canonical_doctype_promotion_state")
      .select(
        "canonical_plan_id, document_type, doctype_promoted, promotion_event_type, promoted_at, re_baseline_required, coverage_score, distinct_users_count, total_qualifying_uploads, last_evaluated_at",
      )
      .order("last_evaluated_at", { ascending: false, nullsFirst: false })
      .limit(200);
    if (promotedParam === "true" || promotedParam === "false") {
      q = q.eq("doctype_promoted", promotedParam === "true");
    }
    if (docType) q = q.eq("document_type", docType);
    const { data, error } = await q;
    if (error) {
      console.error("[canonical-quality] promotion query failed:", error.message);
      return NextResponse.json({ error: "Failed to load promotion state" }, { status: 500 });
    }
    return NextResponse.json({ view, rows: data ?? [] });
  }

  if (view === "invalidation") {
    const [events, drift] = await Promise.all([
      supabase
        .from("canonical_invalidation_events")
        .select(
          "id, canonical_plan_id, document_type, event_type, triggering_user_ids, divergent_value_jsonb, baseline_value_jsonb, admin_disposition, admin_disposition_at, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("canonical_drift_events")
        .select(
          "id, canonical_plan_id, document_type, detection_type, divergence_rate_30d, divergent_user_count_30d, window_days, triggered_re_baseline, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    if (events.error || drift.error) {
      console.error("[canonical-quality] invalidation query failed:", events.error?.message ?? drift.error?.message);
      return NextResponse.json({ error: "Failed to load invalidation data" }, { status: 500 });
    }
    return NextResponse.json({ view, events: events.data ?? [], drift: drift.data ?? [] });
  }

  if (view === "divergence") {
    const statusParam = req.nextUrl.searchParams.get("status") ?? "pending";
    let q = supabase
      .from("canonical_divergence_review")
      .select(
        "id, canonical_plan_id, document_type, field_name, minority_value_jsonb, minority_value_key, minority_weight, total_weight, minority_share, contributing_user_ids, divergence_type, status, admin_notes, created_at, updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (statusParam !== "all") q = q.eq("status", statusParam);
    const { data, error } = await q;
    if (error) {
      console.error("[canonical-quality] divergence query failed:", error.message);
      return NextResponse.json({ error: "Failed to load divergence review" }, { status: 500 });
    }
    return NextResponse.json({ view, rows: data ?? [] });
  }

  return NextResponse.json({ error: `Unknown view: ${view}` }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { supabase, adminUserId } = auth;

  let body: {
    target?: "divergence" | "invalidation";
    id?: string;
    status?: string;
    divergence_type?: string;
    admin_notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { target, id, status } = body;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!status || !DISPOSITION_STATUSES.includes(status as (typeof DISPOSITION_STATUSES)[number])) {
    return NextResponse.json({ error: `status must be one of ${DISPOSITION_STATUSES.join(", ")}` }, { status: 400 });
  }
  const now = new Date().toISOString();

  if (target === "divergence") {
    const divergenceType = body.divergence_type ?? "unclassified";
    if (!DIVERGENCE_TYPES.includes(divergenceType as (typeof DIVERGENCE_TYPES)[number])) {
      return NextResponse.json({ error: `divergence_type must be one of ${DIVERGENCE_TYPES.join(", ")}` }, { status: 400 });
    }
    const { error } = await supabase
      .from("canonical_divergence_review")
      .update({
        status,
        divergence_type: divergenceType,
        admin_user_id: adminUserId,
        admin_disposition_at: now,
        admin_notes: body.admin_notes ?? null,
        updated_at: now,
      })
      .eq("id", id);
    if (error) {
      console.error("[canonical-quality] divergence disposition failed:", error.message);
      return NextResponse.json({ error: "Disposition failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (target === "invalidation") {
    const { error } = await supabase
      .from("canonical_invalidation_events")
      .update({ admin_disposition: status, admin_user_id: adminUserId, admin_disposition_at: now })
      .eq("id", id);
    if (error) {
      console.error("[canonical-quality] invalidation disposition failed:", error.message);
      return NextResponse.json({ error: "Disposition failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "target must be 'divergence' or 'invalidation'" }, { status: 400 });
}
