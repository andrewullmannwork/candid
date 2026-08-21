/**
 * GET /api/cron/retry-stuck
 *
 * Daily safety net (Vercel Cron, 8am UTC).
 * Finds documents stuck in processing/queued for >5 minutes
 * and restarts their processing chains.
 *
 * S322 — the restart leg had NEVER worked on Vercel: it fired an unsigned,
 * un-awaited fetch at /api/documents/process-chunk, which (a) requires a
 * QStash signature on every Vercel deploy (B9-1 §C4 → guaranteed 401) and
 * (b) usually died with the frozen function anyway. The cron reset docs to
 * `queued`, logged "Retrying…", returned {retried: N} — and nothing ever
 * restarted (observed live on doc 3f01db1d: reset fields, retry 0, parked in
 * `queued` across two cron days). Now it restarts through enqueueChunk — the
 * pipeline's own QStash-signed publish — AWAITED, with retry_count
 * incremented per attempt (the reprocess route's exact semantics) and a
 * terminal `error` write after MAX_RESTARTS so a doc that can't restart
 * stops being "retried" silently forever (S320: recovery must terminate).
 * The response reports per-doc enqueue truth, not just a count.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { isAuthorizedCron } from "@/lib/security/require-cron-secret";
import { enqueueChunk } from "@/lib/queue/qstash";
import { deriveBaseUrl } from "@/lib/documents/ingest-upload";

// Matches the reprocess route's MAX_RETRIES — the shared "restart attempts"
// budget carried in documents.retry_count.
const MAX_RESTARTS = 3;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  // Find stuck documents (processing/queued for >5 minutes)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: stuckDocs } = await supabase
    .from("documents")
    .select("id, status, processing_step, processing_started_at, retry_count")
    .in("status", ["queued", "processing"])
    .or(`processing_started_at.lt.${fiveMinAgo},processing_started_at.is.null`)
    .limit(5);

  if (!stuckDocs || stuckDocs.length === 0) {
    return NextResponse.json({ message: "No stuck documents", retried: 0 });
  }

  const results: Array<{ id: string; was: string; enqueued?: boolean; terminal?: boolean }> = [];
  for (const doc of stuckDocs) {
    const was = `${doc.status}/${doc.processing_step}`;
    const retryCount = (doc.retry_count as number | null) ?? 0;

    if (retryCount >= MAX_RESTARTS) {
      // Terminal write — without it, a doc that can't restart is "retried"
      // every day forever while the user sees an eternal spinner.
      await supabase.from("documents").update({
        status: "error",
        processing_error:
          "Processing could not be restarted after repeated attempts. Please upload the document again.",
      }).eq("id", doc.id);
      console.warn(`[cron/retry-stuck] Document ${doc.id} exhausted ${MAX_RESTARTS} restarts (was ${was}) — marked error`);
      results.push({ id: doc.id as string, was, terminal: true });
      continue;
    }

    // Reset to queued state so process-chunk can pick it up fresh
    await supabase.from("documents").update({
      status: "queued",
      processing_step: null,
      processing_started_at: null,
      processing_completed_pages: 0,
      processing_ocr_text: null,
      retry_count: retryCount + 1,
    }).eq("id", doc.id);

    // Trigger the processing chain through QStash (signed; survives this
    // function returning). AWAITED — the old fire-and-forget fetch is the
    // reason this cron never actually restarted anything.
    const enqueued = await enqueueChunk(doc.id as string, deriveBaseUrl(req));
    if (!enqueued) {
      console.error(`[cron/retry-stuck] enqueue FAILED for document ${doc.id} (was ${was})`);
    } else {
      console.log(`[cron/retry-stuck] Retrying document ${doc.id} (was ${was}, attempt ${retryCount + 1}/${MAX_RESTARTS})`);
    }
    results.push({ id: doc.id as string, was, enqueued });
  }

  const retried = results.filter((r) => r.enqueued).length;
  return NextResponse.json({
    message: `Restarted ${retried} of ${results.length} stuck document(s)`,
    retried,
    results,
  });
}
