import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

interface ConsentPayload {
  type: string;
  version: string;
  hash: string;
}

export async function POST(req: NextRequest) {
  try {
    const { idToken, consents } = (await req.json()) as {
      idToken: string;
      consents?: ConsentPayload[];
    };
    if (!idToken) {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }

    // 1. Verify Firebase token
    console.log("[auth/sync] Step 1: Verifying Firebase token...");
    let decoded;
    try {
      decoded = await getAdminAuth().verifyIdToken(idToken);
    } catch (fbErr) {
      const msg = fbErr instanceof Error ? fbErr.message : String(fbErr);
      console.error("[auth/sync] Firebase token verification failed:", msg);
      return NextResponse.json({ error: `Firebase auth failed: ${msg}` }, { status: 401 });
    }

    const { uid, email, name } = decoded;
    console.log("[auth/sync] Step 1 OK — uid:", uid, "email:", email);

    if (!email) {
      return NextResponse.json({ error: "No email in token" }, { status: 400 });
    }

    const supabase = createServerClient();

    // 2. Upsert user in Supabase — link accounts by email
    // If a user signed up with email/password and later signs in with Google (or vice versa),
    // they have different Firebase UIDs but the same email. We find by email first to avoid
    // creating duplicate accounts.
    console.log("[auth/sync] Step 2: Upserting user in Supabase...");

    // Check if a user with this email already exists (possibly from a different auth method)
    const { data: existingByEmail } = await supabase
      .from("users")
      .select("id, firebase_uid")
      .eq("email", email)
      .single();

    let userId: string;

    if (existingByEmail && existingByEmail.firebase_uid !== uid) {
      // Same email, different Firebase UID — link the account by updating the UID
      console.log(`[auth/sync] Account linking: email ${email} exists with UID ${existingByEmail.firebase_uid}, updating to ${uid}`);
      const { error: linkError } = await supabase
        .from("users")
        .update({ firebase_uid: uid, display_name: name || undefined })
        .eq("id", existingByEmail.id);
      if (linkError) {
        console.error("[auth/sync] Account linking failed:", linkError);
        return NextResponse.json({ error: `Account linking failed: ${linkError.message}` }, { status: 500 });
      }
      userId = existingByEmail.id;
      console.log("[auth/sync] Step 2 OK — linked to existing user:", userId);
    } else {
      // Normal upsert — new user or same UID
      const { data: upsertedUser, error: upsertError } = await supabase
        .from("users")
        .upsert(
          { firebase_uid: uid, email, display_name: name || null },
          { onConflict: "firebase_uid" }
        )
        .select("id")
        .single();

      if (upsertError || !upsertedUser) {
        console.error("[auth/sync] Failed to upsert user:", upsertError);
        return NextResponse.json({ error: `Failed to upsert user: ${upsertError?.message || "unknown"}` }, { status: 500 });
      }
      userId = upsertedUser.id;
      console.log("[auth/sync] Step 2 OK — user:", userId);
    }

    // 3. Record consent events (server-side, service role bypasses RLS)
    if (consents && consents.length > 0) {
      console.log("[auth/sync] Step 3: Recording", consents.length, "consent events...");
      const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null;
      const userAgent = req.headers.get("user-agent") || null;

      const consentRows = consents.map((c) => ({
        user_id: userId,
        email,
        consent_type: c.type,
        consent_version: c.version,
        consent_text_hash: c.hash,
        granted: true,
        ip_address: ip,
        user_agent: userAgent,
      }));

      const { error: consentError } = await supabase
        .from("consent_events")
        .insert(consentRows);

      if (consentError) {
        console.error("[auth/sync] Consent insert error:", consentError);
        // Don't fail the whole sync — user is created, consent can be re-recorded
      } else {
        console.log("[auth/sync] Step 3 OK — consent recorded");
      }
    }

    // 4. Ensure Stripe Customer exists
    console.log("[auth/sync] Step 4: Checking Stripe customer...");
    const { data: stripeRecord } = await supabase
      .from("stripe_customers")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .single();

    let stripeCustomerId: string;

    if (stripeRecord) {
      stripeCustomerId = stripeRecord.stripe_customer_id;
      console.log("[auth/sync] Step 4 OK — existing Stripe customer:", stripeCustomerId);
    } else {
      console.log("[auth/sync] Step 4: Creating Stripe customer...");
      try {
        const customer = await getStripe().customers.create({
          email,
          metadata: { candid_user_id: userId, firebase_uid: uid },
        });
        stripeCustomerId = customer.id;

        await supabase.from("stripe_customers").insert({
          user_id: userId,
          stripe_customer_id: stripeCustomerId,
        });
        console.log("[auth/sync] Step 4 OK — new Stripe customer:", stripeCustomerId);
      } catch (stripeErr) {
        const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr);
        console.error("[auth/sync] Stripe customer creation failed:", msg);
        return NextResponse.json(
          { error: `Stripe setup failed: ${msg}` },
          { status: 500 }
        );
      }
    }

    // 5. Set session indicator cookie so middleware allows protected routes
    const response = NextResponse.json({ userId, email, stripeCustomerId });
    response.cookies.set("candid_session", "1", {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    console.log("[auth/sync] All steps complete for", email);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("[auth/sync] Unhandled error:", message);
    if (stack) console.error(stack);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
