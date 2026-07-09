import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { getUsageStats } from "@/lib/config/processing-usage";
import { FLAGS } from "@/lib/config/feature-flags";
import { processDocument } from "@/lib/documents/process-document";
import type { DocumentRow } from "@/lib/supabase/types";

export const maxDuration = 300;

/** GET: Return current usage stats and feature flag state */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const stats = await getUsageStats();

  // Get queued document count
  const supabase = createServerClient();
  const { count: queuedCount } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");

  return NextResponse.json({
    usage: stats,
    queuedDocuments: queuedCount || 0,
    flags: {
      ocrEnabled: FLAGS.OCR_ENABLED,
      autoProcessOnUpload: FLAGS.AUTO_PROCESS_ON_UPLOAD,
      claudeExtractionEnabled: FLAGS.CLAUDE_EXTRACTION_ENABLED,
      onDemandExtractionEnabled: FLAGS.ON_DEMAND_EXTRACTION_ENABLED,
      uploadMaxPages: FLAGS.UPLOAD_MAX_PAGES,
      uploadMaxPerUser: FLAGS.UPLOAD_MAX_PER_USER,
      uploadMaxFileSize: FLAGS.UPLOAD_MAX_FILE_SIZE,
    },
  });
}

/** POST: Process a specific queued document (admin override — bypasses caps) */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { action, documentId } = await req.json();

  if (action === "process_document" && documentId) {
    // Look up the document, then process it directly with admin override
    // (bypasses the per-day cost cap; this route is is_admin-gated above). The
    // previous internal HTTP hop with an `x-admin-override` header is removed.
    const supabase = createServerClient();
    const { data: doc } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .single();
    if (!doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    const billType = doc.doc_type || "eob";

    const result = await processDocument(supabase, {
      doc: doc as DocumentRow,
      billType,
      adminOverride: true,
    });
    return NextResponse.json(result.body, { status: result.status });
  }

  if (action === "process_all_queued") {
    // Process all queued documents (admin override)
    const supabase = createServerClient();
    const { data: queued } = await supabase
      .from("documents")
      .select("*")
      .eq("status", "queued")
      .limit(10); // Process in batches of 10

    if (!queued || queued.length === 0) {
      return NextResponse.json({ message: "No queued documents", processed: 0 });
    }

    let processed = 0;
    let errors = 0;
    for (const doc of queued) {
      try {
        const billType = ["sbc", "plan_document", "itemized_bill"].includes(doc.doc_type) ? doc.doc_type : "eob";
        const result = await processDocument(supabase, {
          doc: doc as DocumentRow,
          billType,
          adminOverride: true,
        });
        if (result.status >= 200 && result.status < 300) processed++;
        else errors++;
      } catch {
        errors++;
      }
    }

    return NextResponse.json({
      message: `Processed ${processed} documents, ${errors} errors`,
      processed,
      errors,
      remaining: Math.max(0, (queued.length || 0) - processed),
    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
