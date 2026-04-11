import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const RESEND_API_BASE = "https://api.resend.com";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

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
