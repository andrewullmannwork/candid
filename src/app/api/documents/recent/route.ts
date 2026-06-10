/**
 * S78 — async ingestion notification source-of-truth.
 *
 * Returns the authenticated user's recently-processed documents (last 24 hours)
 * so the ParseCompleteBanner component on every authed page can decide whether
 * to render the "Your upload of [doc_name] is complete" banner.
 *
 * Client-side state machine (banner.tsx):
 *   1. Poll this endpoint every 30s while tab visible.
 *   2. For each returned doc: check localStorage[`dismissed_doc_notifications`].
 *      If dismissed → skip (auto-dismissal after 10 min OR user-click close
 *      both write to this set).
 *   3. Otherwise: check localStorage[`first_seen_doc_notifications`][doc.id].
 *      If set AND (now - first_seen > 10 min) → add to dismissed set + skip.
 *      Else if not set → write first_seen=now() + render banner.
 *      Else (first_seen set + within 10 min window) → render banner.
 *
 * Server-side scope:
 *   - 24h cap on created_at — banners shouldn't surface for docs from days ago
 *     (those should just live in the email inbox + dashboard listing).
 *   - 30-page filter — small docs use sync PlayfulParsingScreen and don't need
 *     the banner since the user already saw the doc finish in-session.
 *   - User-scoped via userScoped() (service-role bypasses RLS; the app-layer
 *     ownership filter on user_id is the enforcement, not RLS).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { userScoped } from "@/lib/security/user-scoped";

// Same cutoff used in onboarding-emails.ts + upload route.ts. Sub-30-page docs
// don't trigger the async UX and don't need banner surfacing.
const LARGE_DOC_PAGE_THRESHOLD = 30;

// 24h cap — older processed docs shouldn't pop a banner. Email + dashboard
// listing are the long-term surfaces.
const LOOKBACK_HOURS = 24;

interface RecentDoc {
  id: string;
  file_name: string;
  processing_total_pages: number | null;
  created_at: string;
}

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Gate on async ingestion flag. When OFF (default in dev), return empty so
  // banner never appears even if client polls.
  const asyncIngestionEnabled = await isFeatureEnabled("async_ingestion_ux_v1", decoded.email ?? undefined);
  if (!asyncIngestionEnabled) {
    return NextResponse.json({ documents: [] });
  }

  const supabase = createServerClient();

  // Resolve internal user_id from Firebase UID
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ documents: [] });
  }

  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data: docs, error } = await userScoped(supabase, user.id)
    .table("documents")
    .select("id, file_name, processing_total_pages, created_at")
    .eq("status", "processed")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("[documents/recent] Query failed:", error);
    return NextResponse.json({ documents: [] });
  }

  // Filter to large docs only — small docs use sync PlayfulParsingScreen so the
  // banner isn't a useful surface for them.
  const eligible = (docs ?? []).filter((d: RecentDoc) => {
    const pages = d.processing_total_pages ?? 0;
    return pages > LARGE_DOC_PAGE_THRESHOLD;
  });

  return NextResponse.json({ documents: eligible });
}
