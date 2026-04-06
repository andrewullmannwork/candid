/**
 * GET /api/cron/retry-stuck
 *
 * Daily safety net (Vercel Cron, 8am UTC).
 * Finds documents stuck in processing/queued for >30 minutes
 * and restarts their processing chains.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  // Verify cron secret (Vercel sends this automatically)
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  // Find stuck documents (processing/queued for >5 minutes)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: stuckDocs } = await supabase
    .from("documents")
    .select("id, status, processing_step, processing_started_at")
    .in("status", ["queued", "processing"])
    .or(`processing_started_at.lt.${fiveMinAgo},processing_started_at.is.null`)
    .limit(5);

  if (!stuckDocs || stuckDocs.length === 0) {
    return NextResponse.json({ message: "No stuck documents", retried: 0 });
  }

  let retried = 0;
  for (const doc of stuckDocs) {
    // Reset to queued state so process-chunk can pick it up fresh
    await supabase.from("documents").update({
      status: "queued",
      processing_step: null,
      processing_started_at: null,
      processing_completed_pages: 0,
      processing_ocr_text: null,
    }).eq("id", doc.id);

    // Trigger processing chain
    const chunkUrl = new URL("/api/documents/process-chunk", req.url);
    fetch(chunkUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: doc.id }),
    }).catch(() => {});

    retried++;
    console.log(`[cron/retry-stuck] Retrying document ${doc.id} (was ${doc.status}/${doc.processing_step})`);
  }

  return NextResponse.json({ message: `Retried ${retried} stuck documents`, retried });
}
