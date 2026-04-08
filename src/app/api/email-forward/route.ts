import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body?.type !== "email.received") {
      return NextResponse.json({ received: true });
    }

    const { from, subject, text, html } = body.data || {};

    await resend.emails.send({
      from: "forward@candidclaim.com",
      to: "andrew.david.ullmann@gmail.com",
      subject: `[CandidClaim] ${subject || "(no subject)"}`,
      replyTo: from || undefined,
      html: html || `<pre>${text || "(empty)"}</pre>`,
    });

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[email-forward] Error:", err);
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
