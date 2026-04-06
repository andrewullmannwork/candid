/**
 * GET /api/documents/status?id=<documentId>
 * POST /api/documents/status (with { documentId, action: "trigger" })
 *
 * Lightweight polling endpoint for the client to check processing progress
 * and trigger the next chunk when needed. No auth required for GET (document
 * IDs are UUIDs and not guessable). POST trigger calls process-chunk.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const documentId = req.nextUrl.searchParams.get("id");
  if (!documentId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("status, processing_step, processing_completed_pages, processing_total_pages")
    .eq("id", documentId)
    .single();

  if (!doc) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Determine if the client should trigger a chunk
  const needsTrigger =
    (doc.status === "queued" && !doc.processing_step) || // Never started
    (doc.status === "processing" && doc.processing_step && !doc.processing_step.startsWith("working_")); // Ready for next step

  return NextResponse.json({
    status: doc.status,
    step: doc.processing_step,
    completedPages: doc.processing_completed_pages || 0,
    totalPages: doc.processing_total_pages || 0,
    needsTrigger,
  });
}

export async function POST(req: NextRequest) {
  const { documentId } = await req.json();
  if (!documentId) {
    return NextResponse.json({ error: "documentId required" }, { status: 400 });
  }

  // Trigger the next chunk by calling process-chunk internally
  const chunkUrl = new URL("/api/documents/process-chunk", req.url);
  try {
    const res = await fetch(chunkUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId }),
    });
    const result = await res.json();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: "Trigger failed" }, { status: 500 });
  }
}
