/**
 * Admin GET for /admin/canonical-match-decisions (Ing-K Phase 1, S129).
 *
 *   GET /api/admin/canonical-match-decisions?window_days=7&view=summary
 *   GET /api/admin/canonical-match-decisions?window_days=7&view=signatures
 *   GET /api/admin/canonical-match-decisions?window_days=7&view=near_misses
 *
 * View modes:
 *   - summary: per-step counts + total decisions over window
 *   - signatures: GROUP BY input_signature, sorted by distinct matched_canonical_id
 *                 desc — surfaces "same signature created N canonicals" (the Ing-K
 *                 dedup-quality bug). Returns top 50.
 *   - near_misses: step_matched=create_new AND best_score in 0.5-0.7, sorted by
 *                  best_score desc — would-have-matched cases under lower
 *                  threshold. Returns top 50.
 *
 * Auth: admin-only via Firebase ID token → users.is_admin. Mirrors the gate
 * used by /api/admin/auto-reparse-stats.
 *
 * Aggregation strategy: pulls raw rows for the window + aggregates in JS.
 * Admin traffic is low; expected row volume at MVP ≤ 1k per 7d window.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

async function requireAdmin(req: NextRequest): Promise<
  | { ok: true; supabase: ReturnType<typeof createServerClient> }
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
    return { ok: true, supabase };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid token" }, { status: 401 }) };
  }
}

type View = "summary" | "signatures" | "near_misses";

interface DecisionRow {
  id: string;
  document_id: string | null;
  insurance_plan_id: string | null;
  input_signature: string;
  step_matched: string;
  best_score: number | null;
  candidate_count: number;
  matched_canonical_id: string;
  rejected_top_candidate_id: string | null;
  input_payload: Record<string, unknown>;
  reason: string | null;
  created_at: string;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const windowDaysRaw = Number(req.nextUrl.searchParams.get("window_days") ?? "7");
  const windowDays =
    Number.isFinite(windowDaysRaw) && windowDaysRaw > 0 && windowDaysRaw <= 90 ? windowDaysRaw : 7;
  const view = (req.nextUrl.searchParams.get("view") ?? "summary") as View;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await auth.supabase
    .from("canonical_match_decisions")
    .select(
      "id, document_id, insurance_plan_id, input_signature, step_matched, best_score, candidate_count, matched_canonical_id, rejected_top_candidate_id, input_payload, reason, created_at",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    console.error("[canonical-match-decisions] query failed:", error.message);
    return NextResponse.json({ error: "Failed to load decisions" }, { status: 500 });
  }

  const rows = (data ?? []) as DecisionRow[];

  if (view === "summary") {
    const byStep: Record<string, number> = {};
    for (const r of rows) {
      byStep[r.step_matched] = (byStep[r.step_matched] ?? 0) + 1;
    }
    const totalDecisions = rows.length;
    const createNewCount = byStep["create_new"] ?? 0;
    const matchedCount = totalDecisions - createNewCount;
    const matchRate = totalDecisions > 0 ? matchedCount / totalDecisions : 0;
    return NextResponse.json({
      view: "summary",
      window_days: windowDays,
      total_decisions: totalDecisions,
      match_rate: Number(matchRate.toFixed(4)),
      by_step: byStep,
    });
  }

  if (view === "signatures") {
    // GROUP BY input_signature, surface signatures that produced multiple
    // distinct matched_canonical_ids (the Ing-K bug pattern).
    const bySig = new Map<
      string,
      {
        input_signature: string;
        distinct_canonicals: Set<string>;
        decision_count: number;
        step_counts: Record<string, number>;
        sample_input: Record<string, unknown>;
        last_seen: string;
      }
    >();
    for (const r of rows) {
      let entry = bySig.get(r.input_signature);
      if (!entry) {
        entry = {
          input_signature: r.input_signature,
          distinct_canonicals: new Set(),
          decision_count: 0,
          step_counts: {},
          sample_input: r.input_payload,
          last_seen: r.created_at,
        };
        bySig.set(r.input_signature, entry);
      }
      entry.distinct_canonicals.add(r.matched_canonical_id);
      entry.decision_count += 1;
      entry.step_counts[r.step_matched] = (entry.step_counts[r.step_matched] ?? 0) + 1;
      if (r.created_at > entry.last_seen) entry.last_seen = r.created_at;
    }
    const signatures = Array.from(bySig.values())
      .map((s) => ({
        input_signature: s.input_signature,
        distinct_canonicals_count: s.distinct_canonicals.size,
        decision_count: s.decision_count,
        step_counts: s.step_counts,
        sample_input: {
          planName: s.sample_input.planName,
          insurerId: s.sample_input.insurerId,
          planYear: s.sample_input.planYear,
        },
        last_seen: s.last_seen,
      }))
      .sort((a, b) => {
        if (b.distinct_canonicals_count !== a.distinct_canonicals_count) {
          return b.distinct_canonicals_count - a.distinct_canonicals_count;
        }
        return b.decision_count - a.decision_count;
      })
      .slice(0, 50);
    return NextResponse.json({
      view: "signatures",
      window_days: windowDays,
      total_signatures: bySig.size,
      signatures,
    });
  }

  if (view === "near_misses") {
    // create_new with best_score in 0.5-0.7 — would-have-matched under lower
    // threshold. The most actionable surface for Phase 2 fix calibration.
    const nearMisses = rows
      .filter(
        (r) =>
          r.step_matched === "create_new" &&
          r.best_score !== null &&
          r.best_score >= 0.5 &&
          r.best_score < 0.7,
      )
      .sort((a, b) => (b.best_score ?? 0) - (a.best_score ?? 0))
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        document_id: r.document_id,
        input_signature: r.input_signature,
        best_score: r.best_score,
        candidate_count: r.candidate_count,
        matched_canonical_id: r.matched_canonical_id,
        rejected_top_candidate_id: r.rejected_top_candidate_id,
        sample_input: {
          planName: r.input_payload.planName,
          insurerId: r.input_payload.insurerId,
          planYear: r.input_payload.planYear,
        },
        reason: r.reason,
        created_at: r.created_at,
      }));
    return NextResponse.json({
      view: "near_misses",
      window_days: windowDays,
      count: nearMisses.length,
      near_misses: nearMisses,
    });
  }

  return NextResponse.json({ error: `Unknown view: ${view}` }, { status: 400 });
}
