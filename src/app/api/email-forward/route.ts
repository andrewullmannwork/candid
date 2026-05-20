import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { Webhook } from "svix";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const RESEND_API_BASE = "https://api.resend.com";

// Strict signature verification on Vercel deploys (Preview + Production).
// Local dev (no VERCEL_ENV) skips verification — the local dev server is not
// a Resend webhook target in practice, and Resend's webhook URL points only
// at the deployed environments.
const IS_VERCEL_DEPLOY = !!process.env.VERCEL_ENV;

export async function POST(req: NextRequest) {
  try {
    // Read raw body BEFORE JSON.parse — Svix signature is computed over the
    // exact bytes Resend sent. JSON.parse + re-serialize would change them.
    const rawBody = await req.text();

    if (IS_VERCEL_DEPLOY) {
      const secret = process.env.RESEND_WEBHOOK_SECRET;
      if (!secret) {
        // Fail-closed: in a Vercel deploy the secret MUST be configured.
        // Returning 500 surfaces the misconfig in Vercel logs immediately.
        console.error("[email-forward] FATAL: RESEND_WEBHOOK_SECRET missing in Vercel deploy");
        return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
      }
      const svixId = req.headers.get("svix-id");
      const svixTimestamp = req.headers.get("svix-timestamp");
      const svixSignature = req.headers.get("svix-signature");
      if (!svixId || !svixTimestamp || !svixSignature) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const wh = new Webhook(secret);
        wh.verify(rawBody, {
          "svix-id": svixId,
          "svix-timestamp": svixTimestamp,
          "svix-signature": svixSignature,
        });
      } catch (verifyErr) {
        console.warn("[email-forward] Signature verification failed:", verifyErr);
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    } else {
      console.warn("[email-forward] Signature verification skipped — running outside Vercel deploy");
    }

    const body = JSON.parse(rawBody);

    if (body?.type !== "email.received") {
      return NextResponse.json({ received: true });
    }

    const { email_id, from, subject } = body.data || {};

    // Resend webhook only includes metadata — fetch full email content via API
    let html = "";
    let text = "";
    console.log("[email-forward] Webhook payload:", JSON.stringify(body).slice(0, 500));
    if (email_id && process.env.RESEND_API_KEY) {
      try {
        const url = `${RESEND_API_BASE}/emails/receiving/${email_id}`;
        console.log("[email-forward] Fetching email content from:", url);
        const emailRes = await fetch(url, {
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        });
        const emailData = await emailRes.json();
        console.log("[email-forward] API response status:", emailRes.status, "keys:", Object.keys(emailData));
        if (emailRes.ok) {
          html = emailData.html || "";
          text = emailData.text || "";
        } else {
          console.error("[email-forward] API error:", JSON.stringify(emailData).slice(0, 300));
        }
      } catch (fetchErr) {
        console.error("[email-forward] Failed to fetch email content:", fetchErr);
      }
    } else {
      console.error("[email-forward] Missing email_id or API key. email_id:", email_id, "hasKey:", !!process.env.RESEND_API_KEY);
    }

    if (!resend) {
      return NextResponse.json({ error: "Email service not configured" }, { status: 503 });
    }
    await resend.emails.send({
      from: "forward@candidclaim.com",
      to: "andrew.david.ullmann@gmail.com",
      subject: `[CandidClaim] ${subject || "(no subject)"}`,
      replyTo: from || undefined,
      html: html || `<pre>${text || "(email body unavailable — check Resend dashboard)"}</pre>`,
    });

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[email-forward] Error:", err);
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
