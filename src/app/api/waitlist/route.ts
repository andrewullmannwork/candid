import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getConsentDocument } from "@/lib/consent/consent-documents";
import { z } from "zod";

const waitlistSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email } = waitlistSchema.parse(body);

    const supabase = createServerClient();

    // Upsert into waitlist (ignore duplicate emails)
    const { error: waitlistError } = await supabase
      .from("waitlist")
      .upsert({ email }, { onConflict: "email" });

    if (waitlistError) {
      console.error("Waitlist insert error:", waitlistError);
      return NextResponse.json({ error: "Failed to join waitlist" }, { status: 500 });
    }

    // Record ToS + Privacy Policy consent for the waitlist signup (pre-auth)
    const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null;
    const userAgent = req.headers.get("user-agent") || null;

    const tosDoc = getConsentDocument("tos");
    const privacyDoc = getConsentDocument("privacy_policy");

    await supabase.from("consent_events").insert([
      {
        email,
        consent_type: "tos" as const,
        consent_version: tosDoc.version,
        consent_text_hash: tosDoc.hash,
        granted: true,
        ip_address: ip,
        user_agent: userAgent,
      },
      {
        email,
        consent_type: "privacy_policy" as const,
        consent_version: privacyDoc.version,
        consent_text_hash: privacyDoc.hash,
        granted: true,
        ip_address: ip,
        user_agent: userAgent,
      },
    ]);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0].message }, { status: 400 });
    }
    console.error("Waitlist error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
