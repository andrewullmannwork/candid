import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
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
    if (email_id && process.env.RESEND_API_KEY) {
      try {
        const emailRes = await fetch(`${RESEND_API_BASE}/emails/${email_id}`, {
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        });
        if (emailRes.ok) {
          const emailData = await emailRes.json();
          html = emailData.html || "";
          text = emailData.text || "";
        }
      } catch (fetchErr) {
        console.error("[email-forward] Failed to fetch email content:", fetchErr);
      }
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
