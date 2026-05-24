/**
 * POST /api/support
 *
 * B2.3 (Session 123) — extended payload per D-§1.B.3-A. Accepts multipart/form-
 * data (when an attachment is present) or application/json (no attachment).
 *
 * Multipart fields:
 *   - category: string (5 design IDs: bill/plan/benefits/billing/other)
 *   - subject: string (>2 chars; max 120)
 *   - body: string (>10 chars; max 1500)
 *   - linkedDocumentId: string UUID (optional; only for category=bill)
 *   - attachment: File (optional; PDF/JPG/PNG; max 25MB)
 *
 * JSON fields (same shape, no attachment): same keys.
 *
 * Behavior:
 *   - Validates user via Firebase Bearer token.
 *   - If attachment present: uploads to `support-attachments` bucket at
 *     `{user_id}/{ticket_uuid}-{filename}`. If upload fails, ticket is still
 *     created without attachment (logged warning; not user-facing).
 *   - Inserts into support_tickets with all extended columns.
 *   - Returns { success: true, ticket_id: uuid } so client can display CN-XXXXX
 *     short id derived from first 5 hex chars of UUID.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { postSupportTicket } from "@/lib/slack/support-notifications";

const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const ATTACHMENT_ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
]);
const VALID_CATEGORIES = new Set(["bill", "plan", "benefits", "billing", "other"]);

interface TicketPayload {
  category?: string;
  subject?: string;
  body?: string;
  linkedDocumentId?: string | null;
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();

    const { data: user } = await supabase
      .from("users")
      .select("id, email")
      .eq("firebase_uid", decoded.uid)
      .single();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Parse payload — multipart if attachment, JSON otherwise
    const contentType = req.headers.get("content-type") || "";
    const isMultipart = contentType.includes("multipart/form-data");

    let payload: TicketPayload = {};
    let attachment: File | null = null;

    if (isMultipart) {
      const form = await req.formData();
      payload = {
        category: form.get("category")?.toString(),
        subject: form.get("subject")?.toString(),
        body: form.get("body")?.toString(),
        linkedDocumentId: form.get("linkedDocumentId")?.toString() || null,
      };
      const file = form.get("attachment");
      if (file instanceof File && file.size > 0) {
        attachment = file;
      }
    } else {
      payload = await req.json();
    }

    // Validate
    const { category, subject, body, linkedDocumentId } = payload;
    if (!subject || subject.trim().length < 3) {
      return NextResponse.json({ error: "Subject is required" }, { status: 400 });
    }
    if (!body || body.trim().length < 10) {
      return NextResponse.json({ error: "Details are required" }, { status: 400 });
    }
    if (subject.length > 120 || body.length > 1500) {
      return NextResponse.json({ error: "Subject or details exceed length limits" }, { status: 400 });
    }
    if (category && !VALID_CATEGORIES.has(category)) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    }
    if (attachment) {
      if (attachment.size > ATTACHMENT_MAX_BYTES) {
        return NextResponse.json({ error: "Attachment exceeds 25MB" }, { status: 400 });
      }
      if (!ATTACHMENT_ALLOWED_TYPES.has(attachment.type)) {
        return NextResponse.json({ error: "Attachment must be PDF, JPG, or PNG" }, { status: 400 });
      }
    }

    // Insert ticket first so we have the UUID for storage path
    const { data: inserted, error: dbError } = await supabase
      .from("support_tickets")
      .insert({
        user_id: user.id,
        email: user.email,
        category: category ?? null,
        subject: subject.trim(),
        body: body.trim(),
        linked_document_id: linkedDocumentId || null,
      })
      .select("id")
      .single();

    if (dbError || !inserted) {
      console.error("[support] Insert error:", dbError);
      return NextResponse.json({ error: "Failed to create ticket" }, { status: 500 });
    }

    // Upload attachment if present. Best-effort: failure here does NOT block
    // ticket creation — log warning + return success with attachment_url null.
    let storedAttachmentFilename: string | null = null;
    if (attachment) {
      const safeFilename = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
      const storagePath = `${user.id}/${inserted.id}-${safeFilename}`;
      const bytes = await attachment.arrayBuffer();

      const { error: uploadError } = await supabase.storage
        .from("support-attachments")
        .upload(storagePath, bytes, {
          contentType: attachment.type,
          upsert: false,
        });

      if (uploadError) {
        console.warn("[support] Attachment upload failed (ticket created without):", uploadError.message);
      } else {
        storedAttachmentFilename = attachment.name;
        await supabase
          .from("support_tickets")
          .update({
            attachment_url: storagePath,
            attachment_filename: attachment.name,
          })
          .eq("id", inserted.id);
      }
    }

    // Slack Tier 1+2 outbound — post ticket to #support channel via
    // chat.postMessage; store returned thread ts for inbound thread-reply
    // routing (/api/slack/events). Fail-soft.
    let linkedDocumentName: string | null = null;
    if (linkedDocumentId) {
      const { data: linkedDoc } = await supabase
        .from("documents")
        .select("file_name")
        .eq("id", linkedDocumentId)
        .eq("user_id", user.id)
        .single();
      linkedDocumentName = linkedDoc?.file_name ?? null;
    }

    const threadTs = await postSupportTicket({
      ticketId: inserted.id,
      userEmail: user.email ?? "(no email on file)",
      category: category ?? null,
      subject: subject.trim(),
      body: body.trim(),
      linkedDocumentName,
      attachmentFilename: storedAttachmentFilename,
      attachmentSizeBytes: attachment?.size ?? null,
    });

    if (threadTs) {
      await supabase
        .from("support_tickets")
        .update({ slack_thread_ts: threadTs })
        .eq("id", inserted.id);
    }

    return NextResponse.json({ success: true, ticket_id: inserted.id });
  } catch (error) {
    console.error("[support] Unhandled error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
