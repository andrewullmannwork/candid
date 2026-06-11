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
import { userScoped } from "@/lib/security/user-scoped";
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
    const { data: inserted, error: dbError } = await userScoped(supabase, user.id)
      .table("support_tickets")
      .insert({
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
    let storedAttachmentPath: string | null = null;
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
        storedAttachmentPath = storagePath;
        await userScoped(supabase, user.id)
          .table("support_tickets")
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
    //
    // Generate signed URLs (7-day expiry) for linked doc + attachment so the
    // Slack message includes clickable "View document" buttons for the support
    // admin. Without these, admins see filenames but no way to actually read
    // the document — surfaced as a smoke-test UX gap (S123).
    const SIGNED_URL_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days

    let linkedDocumentName: string | null = null;
    let linkedDocumentSignedUrl: string | null = null;
    if (linkedDocumentId) {
      const { data: linkedDoc } = await userScoped(supabase, user.id)
        .table("documents")
        .select("file_name, storage_path")
        .eq("id", linkedDocumentId)
        .single();
      if (linkedDoc) {
        linkedDocumentName = linkedDoc.file_name;
        const { data: signed, error: signError } = await supabase.storage
          .from("documents")
          .createSignedUrl(linkedDoc.storage_path, SIGNED_URL_EXPIRY_SECONDS);
        if (signError) {
          console.warn(`[support] Linked-doc signed URL failed: ${signError.message}`);
        } else {
          linkedDocumentSignedUrl = signed?.signedUrl ?? null;
        }
      }
    }

    let attachmentSignedUrl: string | null = null;
    if (storedAttachmentPath) {
      const { data: signed, error: signError } = await supabase.storage
        .from("support-attachments")
        .createSignedUrl(storedAttachmentPath, SIGNED_URL_EXPIRY_SECONDS);
      if (signError) {
        console.warn(`[support] Attachment signed URL failed: ${signError.message}`);
      } else {
        attachmentSignedUrl = signed?.signedUrl ?? null;
      }
    }

    const threadTs = await postSupportTicket({
      ticketId: inserted.id,
      userEmail: user.email ?? "(no email on file)",
      category: category ?? null,
      subject: subject.trim(),
      body: body.trim(),
      linkedDocumentName,
      linkedDocumentSignedUrl,
      attachmentFilename: storedAttachmentFilename,
      attachmentSizeBytes: attachment?.size ?? null,
      attachmentSignedUrl,
    });

    if (threadTs) {
      const { error: tsError } = await userScoped(supabase, user.id)
        .table("support_tickets")
        .update({ slack_thread_ts: threadTs })
        .eq("id", inserted.id);
      if (tsError) {
        console.warn(
          `[support] Failed to persist slack_thread_ts (is mig 117 applied?): ${tsError.message}`,
        );
      }
    }

    return NextResponse.json({ success: true, ticket_id: inserted.id });
  } catch (error) {
    console.error("[support] Unhandled error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
