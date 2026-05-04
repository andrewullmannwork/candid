/**
 * GET /api/aggregates/disputes — User-facing dispute aggregate metrics endpoint
 *
 * T2.2 v3 (Session 62) — wraps src/lib/disputes/metrics.ts functions in HTTP layer.
 * Per Q-T2.2-13 LOCK + Q-T2.2-4 LOCK SHARPENED + Q-T2.2-12 LOCK Option B.
 *
 * Query params:
 *   - scope: 'personal' | 'aggregate' (default 'aggregate')
 *   - insurer_id: UUID (filter; aggregate scope only)
 *   - audit_rule_id: TEXT (maps to dispute_type filter)
 *   - service_slug: TEXT (filter)
 *   - plan_year_range: 'YYYY-YYYY' or 'YYYY' (default current+prior)
 *
 * Personal scope: returns user's own outcomes (RLS-gated; k-anon NOT enforced).
 * Aggregate scope: cross-user aggregates with k-anon ≥5 distinct user_id per cell;
 *   methodology metadata co-located in response.
 *
 * Auth: Firebase bearer token (matches existing /api/disputes/* pattern).
 * Cache: aggregate scope responses cached at API layer for 1 hour (header).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import {
  getUserDisputeMetrics,
  getAggregateMetrics,
  type AggregateMetrics,
  type UserDisputeMetrics,
} from "@/lib/disputes/metrics";
import { isFeatureEnabled } from "@/lib/config/product-flags";

async function getAuthUserId(req: NextRequest, supabase: ReturnType<typeof createServerClient>): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const { data: user } = await supabase
      .from("users")
      .select("id, email")
      .eq("firebase_uid", decoded.uid)
      .single();
    return user?.id ?? null;
  } catch {
    return null;
  }
}

function parsePlanYearRange(raw: string | null): number[] {
  if (!raw) {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1];
  }
  const trimmed = raw.trim();
  if (/^\d{4}$/.test(trimmed)) return [parseInt(trimmed, 10)];
  const range = trimmed.match(/^(\d{4})-(\d{4})$/);
  if (range) {
    const start = parseInt(range[1], 10);
    const end = parseInt(range[2], 10);
    if (start <= end && end - start <= 10) {
      const out: number[] = [];
      for (let y = start; y <= end; y++) out.push(y);
      return out;
    }
  }
  // Malformed → default
  const currentYear = new Date().getFullYear();
  return [currentYear, currentYear - 1];
}

export async function GET(req: NextRequest) {
  const supabase = createServerClient();

  const userId = await getAuthUserId(req, supabase);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Feature flag gate — flag-OFF returns empty result (UI hides aggregate widget).
  const flagEnabled = await isFeatureEnabled("dispute_feedback_loop");

  const url = req.nextUrl;
  const scope = (url.searchParams.get("scope") ?? "aggregate") as "personal" | "aggregate";
  const insurerCanonicalId = url.searchParams.get("insurer_id") || undefined;
  const planYears = parsePlanYearRange(url.searchParams.get("plan_year_range"));

  if (!flagEnabled) {
    return NextResponse.json({
      scope,
      data: scope === "personal" ? emptyPersonal() : emptyAggregate(planYears),
      flagEnabled: false,
    });
  }

  if (scope === "personal") {
    const data: UserDisputeMetrics = await getUserDisputeMetrics(supabase, userId, { planYears });
    return NextResponse.json({
      scope: "personal",
      data,
      methodology: {
        plan_years_included: planYears,
        states_included: ["filed", "in_progress", "won", "lost", "settled", "withdrawn", "won_on_escalation", "settled_on_escalation", "dispute_letter_drafted", "court_documentation_drafted"],
        k_anon_min_distinct_users: null, // not applicable for personal
        outlier_quarantine_active: true,
        scope_note: "Personal — your own dispute history",
      },
      flagEnabled: true,
    });
  }

  // Aggregate scope (default)
  const data: AggregateMetrics = await getAggregateMetrics(supabase, {
    planYears,
    insurerCanonicalId,
  });

  const response = NextResponse.json({
    scope: "aggregate",
    data,
    methodology: data.methodology,
    flagEnabled: true,
  });
  // 1-hour cache TTL on aggregate scope (Q-T2.2-12 LOCK; admin-tunable via flag config)
  response.headers.set("Cache-Control", "private, max-age=3600");
  return response;
}

function emptyPersonal(): UserDisputeMetrics {
  return {
    totalFiled: 0,
    totalWon: 0,
    totalSettled: 0,
    totalLost: 0,
    totalActive: 0,
    wonOnEscalation: 0,
    totalRecovered: 0,
    totalDisputed: 0,
    winRate: null,
  };
}

function emptyAggregate(planYears: number[]): AggregateMetrics {
  return {
    insurerMetrics: [],
    overallDistinctUsers: 0,
    overallWinRate: null,
    overallRecovered: 0,
    methodology: {
      since: null,
      plan_years_included: planYears,
      k_anon_min_distinct_users: 5,
      states_included: ["won", "lost", "settled", "won_on_escalation", "settled_on_escalation"],
      outlier_quarantine_active: true,
      insurer_canonical_id_used: false,
    },
  };
}
