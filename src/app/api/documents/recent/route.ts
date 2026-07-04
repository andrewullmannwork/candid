/**
 * S78 — async ingestion notification source-of-truth.
 * Cost-H (S267) — extended to a TWO-STATE source: "reading" (in-flight:
 * queued/processing) + "ready" (processed). The ParseCompleteBanner on every
 * authed page renders "We're still reading your [doc]" while it parses in the
 * background, then flips itself to "Your upload of [doc] is complete" — so a
 * large doc the user navigated away from stays visible on return and the
 * reading state dismisses itself the moment status becomes processed.
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

// Cost-H.2 (S198) — the banner fires for docs that took the async "go explore"
// path, i.e. pageCount > ASYNC_REDIRECT_MAX_PAGES (the redirect tier — the
// in-app completion surface, esp. for the future 15-30 band that gets NO email).
// Read from flags in the handler (was a hardcoded 30 shared with
// onboarding-emails + upload route; both now read their own tier flag).

// 24h cap — older processed ("ready") docs shouldn't pop a banner. Email +
// dashboard listing are the long-term surfaces.
const LOOKBACK_HOURS = 24;

// Cost-H (S267) — in-flight ("reading") docs only surface for a bounded window
// so a stuck/dead parse drops off the banner instead of nagging forever. A
// large-doc parse tops out ~15-20 min; 60 min gives comfortable margin.
const IN_FLIGHT_LOOKBACK_MINUTES = 60;

interface RecentDocRow {
  id: string;
  file_name: string;
  processing_total_pages: number | null;
  created_at: string;
  status: string;
  classified_type: string | null;
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

  // Cost-H (S267) — two-state banner source. "ready" = processed (24h window);
  // "reading" = queued/processing (in-flight, bounded window). awaiting_user_
  // confirmation is intentionally excluded — that state belongs to the doc-type
  // modal, not the background-processing banner.
  const { data: docs, error } = await userScoped(supabase, user.id)
    .table("documents")
    .select("id, file_name, processing_total_pages, created_at, status, classified_type")
    .in("status", ["queued", "processing", "processed"])
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("[documents/recent] Query failed:", error);
    return NextResponse.json({ documents: [] });
  }

  // Large docs only — small docs finish during the sync PlayfulParsingScreen, so
  // the banner isn't a useful surface for them. Cost-H.2 (S198): the cutoff is
  // the redirect tier (flag-tunable, default 30). Cost-H (S267): tag each doc
  // "reading" (in-flight, within the bounded window) or "ready" (processed), and
  // drop everything else — so the reading state clears itself the instant a
  // doc's status leaves queued/processing.
  const { getFlags } = await import("@/lib/config/feature-flags");
  const { ASYNC_REDIRECT_MAX_PAGES } = await getFlags();
  const inFlightCutoffMs = Date.now() - IN_FLIGHT_LOOKBACK_MINUTES * 60 * 1000;
  const documents = (docs ?? []).flatMap((d: RecentDocRow) => {
    const pages = d.processing_total_pages ?? 0;
    if (pages <= ASYNC_REDIRECT_MAX_PAGES) return [];
    let state: "reading" | "ready" | null = null;
    if (d.status === "processed") {
      state = "ready"; // already 24h-bounded by the query
    } else if (new Date(d.created_at).getTime() >= inFlightCutoffMs) {
      state = "reading"; // queued/processing within the in-flight window
    }
    if (!state) return [];
    return [{
      id: d.id,
      file_name: d.file_name,
      processing_total_pages: d.processing_total_pages,
      created_at: d.created_at,
      status: d.status,
      classified_type: d.classified_type,
      state,
    }];
  });

  return NextResponse.json({ documents });
}
