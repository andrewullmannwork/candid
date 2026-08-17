import { NextRequest, NextResponse, after } from "next/server";
import { createHash } from "crypto";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { repointOrphanedActivePlan } from "@/lib/claims/claim-plan-link";
import { getStripe } from "@/lib/stripe";
import { sendVerificationEmail, sendWelcomeEmail } from "@/lib/email/onboarding-emails";
import { isFeatureEnabled, readFeatureFlagConfig } from "@/lib/config/product-flags";
import { getFlags } from "@/lib/config/feature-flags";
import { isTestPhoneExempt, TEST_PHONE_EXEMPT_E164 } from "@/lib/auth/test-phone-exempt";
import { verifyTurnstileToken, getRemoteIp } from "@/lib/security/turnstile";
import { consumeRateLimit, ipBucketKey } from "@/lib/security/durable-rate-limit";

interface ConsentPayload {
  type: string;
  version: string;
  hash: string;
}

// first_touch (mig 203) — channel-attribution snapshot captured client-side
// (src/lib/attribution/first-touch). Sanitized to an allowlist of string keys
// with capped lengths; anything else is dropped. Persisted ONLY on the
// new-user INSERT below — first touch wins, resyncs never overwrite.
const FIRST_TOUCH_KEYS = [
  "source",
  "medium",
  "campaign",
  "referrer_host",
  "landing",
  "ts",
  // last_guide — slug of the /learn guide read most recently before signup.
  // Acquisition channel comes from the FIRST visit and so cannot identify the
  // article that converted a returning reader; this carries that separately in
  // the same blob (no schema change — the JSONB shape is ours).
  "last_guide",
] as const;

function sanitizeFirstTouch(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "object") return null;
  const out: Record<string, string> = {};
  for (const key of FIRST_TOUCH_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) out[key] = value.slice(0, 160);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Signup-funnel step markers (mig 206) — records which gate each PERSON
// reached, deduped by a one-way sha256 of the Firebase uid (no PII; retries
// collapse via ON CONFLICT DO NOTHING). Steps: attempted / phone_blocked /
// created. Decoupled via after() (zero added latency) and fail-open — funnel
// telemetry must never affect auth.
type SignupStep = "attempted" | "phone_blocked" | "created";

function recordSignupStep(
  supabase: ReturnType<typeof createServerClient>,
  uid: string,
  step: SignupStep,
): void {
  const uidHash = createHash("sha256").update(uid).digest("hex");
  after(async () => {
    try {
      const { error } = await supabase.rpc("record_signup_step", { p_uid_hash: uidHash, p_step: step });
      // Still fail-open — but a persistent write failure should be
      // diagnosable in logs, not an invisible wall of zeros on /admin/growth.
      if (error) console.warn("[auth/sync] funnel step write failed:", step, error.message);
    } catch {
      /* fail-open */
    }
  });
}

// User-initiated auth actions that must satisfy the Turnstile gate (S68).
// Passive syncs from onAuthStateChanged (page reload, token refresh) omit
// userAction and skip the gate — the user isn't doing anything triggerable
// by a bot, and requiring a token would break legitimate session restoration.
// "anon_check_start" (S315): anonymous bill-check creation — Turnstile-gated
// like signup, and REQUIRED before a new anonymous row may be created below.
type UserAuthAction = "signup" | "signin" | "anon_check_start";

// S315 — shallow shape check for the anonymous results/deletion contact.
// Deliverability is proven by the results email itself, not this regex.
const CONTACT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(req: NextRequest) {
  try {
    const { idToken, consents, userAction, turnstileToken, firstTouch, declaredTestPhone, anonContactEmail } =
      (await req.json()) as {
        idToken: string;
        consents?: ConsentPayload[];
        userAction?: UserAuthAction;
        turnstileToken?: string;
        firstTouch?: unknown;
        // S288 test-phone exemption: the client declares the allowlisted test
        // number when it skipped the Firebase OTP link. Ignored unless it
        // matches the code constant AND the KV kill switch is ON.
        declaredTestPhone?: string;
        // S315 anonymous check: the typed results/deletion contact. Stored as
        // users.contact_email on the anonymous path only — never identity.
        anonContactEmail?: string;
      };
    if (!idToken) {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }

    // Turnstile gate (S68 mig 075). Only enforced on user-initiated auth
    // actions (signup, signin) — passive resyncs aren't bot-triggerable.
    if (userAction) {
      const turnstileEnforced = await isFeatureEnabled("turnstile_enforcement_v1");
      if (turnstileEnforced) {
        const verify = await verifyTurnstileToken(turnstileToken, getRemoteIp(req));
        if (!verify.success) {
          console.warn(
            "[auth/sync] Turnstile verification failed for userAction=" + userAction +
              ", errors=" + JSON.stringify(verify.errorCodes ?? []),
          );
          return NextResponse.json(
            { error: "Bot defense check failed. Please reload and try again." },
            { status: 403 },
          );
        }
      }
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

    const { uid, name } = decoded;

    // S315 — anonymous bill-check path. Keyed on the TOKEN's provider (never
    // client-declared), and available only while the flag is ON.
    const isAnonToken = decoded.firebase?.sign_in_provider === "anonymous";
    if (isAnonToken) {
      const anonEnabled = await isFeatureEnabled("anonymous_bill_check_v1");
      if (!anonEnabled) {
        return NextResponse.json(
          { error: "Anonymous bill check is not available." },
          { status: 403 },
        );
      }
    }

    // Anonymous tokens carry no email. users.email is NOT NULL and the
    // account-link branch below keys on it, so anonymous rows get a synthetic
    // per-uid placeholder — a typed third-party address must never be able to
    // collide with or link to a real account (design §7.1). The typed contact
    // goes to users.contact_email instead.
    const email = decoded.email ?? (isAnonToken ? `anon-${uid}@anon.candidclaim.internal` : undefined);
    console.log("[auth/sync] Step 1 OK — uid:", uid, "email:", email, isAnonToken ? "(anonymous)" : "");

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
      .select("id, firebase_uid, phone_e164")
      .eq("email", email)
      .maybeSingle();

    // Check if this Firebase UID is already known. Combined with existingByEmail,
    // this lets us detect first-time signups (used to gate transactional emails).
    const { data: existingByUid } = await supabase
      .from("users")
      .select("id, phone_e164, is_anonymous")
      .eq("firebase_uid", uid)
      .maybeSingle();

    const isNewUser = !existingByEmail && !existingByUid;

    // S315 — a NEW anonymous row is only ever minted by the explicit
    // "anon_check_start" action (which sits behind the Turnstile gate above);
    // a passive listener sync can't create one. Creation is also IP-capped —
    // each anonymous account is a Haiku-spend vector.
    if (isAnonToken && isNewUser) {
      if (userAction !== "anon_check_start") {
        return NextResponse.json(
          { error: "Anonymous check must be started from the check page." },
          { status: 403 },
        );
      }
      const maxStartsPerDay = await readFeatureFlagConfig(
        "anonymous_bill_check_v1",
        "anon_starts_per_ip_per_day",
        5,
      );
      const rl = await consumeRateLimit(
        ipBucketKey("anon-check", getRemoteIp(req)),
        { windowSeconds: 86_400, maxAttempts: maxStartsPerDay },
        supabase,
      );
      if (!rl.allowed) {
        console.warn("[auth/sync] anon-check IP cap hit; retryAfter=", rl.retryAfterSeconds);
        return NextResponse.json(
          { error: "Too many checks from this network today. Please try again tomorrow." },
          { status: 429 },
        );
      }
    }

    // Mirror the Firebase email_verified token claim on every sync. Drives the
    // Pattern 1 #3 corroboration gate (mig 074) — only email-verified users
    // contribute to canonical promotion threshold.
    const emailVerified = decoded.email_verified === true;

    // S69 mig 076 — Mirror the Firebase phone_number token claim on every sync.
    // Layered with email_verified in evaluate_pattern1_corroboration AND filter
    // (Pattern 1 #15 structural identity defense).
    const phoneE164 = decoded.phone_number ?? null;
    const phoneVerified = phoneE164 !== null;

    // Test-phone exemption (S288, mig 209) — EXACTLY ONE allowlisted test
    // number (TEST_PHONE_EXEMPT_E164) may exist on multiple accounts at once:
    // signup skips the Firebase phone-link (where one-account-per-phone is
    // enforced) and this route stamps the number as verified instead. Gated by
    // the TEST_PHONE_EXEMPTION_ENABLED KV kill switch (/admin/settings →
    // Testing). Two legs, same effect on the writes below:
    //   declared — this signup declares the exempt number (client skipped OTP);
    //   stamped  — the row was stamped by a prior exempt signup; without this
    //              leg the token-claim mirror would null the stamp on the next
    //              passive resync (the token never carries a claim here).
    // Kill switch OFF → both legs false → gate + writes behave exactly as
    // before, and a stamped account downgrades on its next sync.
    let testPhoneExempt = false;
    if (!phoneE164) {
      const declaredExempt =
        typeof declaredTestPhone === "string" && isTestPhoneExempt(declaredTestPhone);
      const stampedExempt =
        existingByUid?.phone_e164 === TEST_PHONE_EXEMPT_E164 ||
        existingByEmail?.phone_e164 === TEST_PHONE_EXEMPT_E164;
      if (declaredExempt || stampedExempt) {
        testPhoneExempt = (await getFlags()).TEST_PHONE_EXEMPTION_ENABLED;
      }
    }
    const effPhoneE164 = phoneE164 ?? (testPhoneExempt ? TEST_PHONE_EXEMPT_E164 : null);
    const effPhoneVerified = phoneVerified || testPhoneExempt;

    // S69 phone-OTP gate (mig 076 phone_otp_enforcement_v1 flag). Fires for
    // explicit signup OR for a brand-new account being created via any path
    // (e.g., a /auth/signin Google attempt for a not-yet-existing account).
    // Q-S69-5: signin path NOT gated for existing users without phone — they
    // can sign in but won't contribute to corroboration (phone_verified=FALSE).
    // S315: anonymous flows bypass the phone gate BY DESIGN (the whole point
    // of the no-account check) and stay OUT of the signup funnel metrics
    // (mig 206 measures the account-signup funnel; anon starts would pollute
    // it). Anti-Sybil is preserved: phone_verified stays FALSE, which is what
    // the corroboration gate actually reads — anonymous parses cannot
    // corroborate canonical until the upgrade's real OTP.
    const isSignupAction = (userAction === "signup" || isNewUser) && !isAnonToken;
    // Funnel (mig 206): an authenticated signup reached the gates.
    if (isSignupAction) recordSignupStep(supabase, uid, "attempted");
    if (isSignupAction) {
      const phoneOtpEnforced = await isFeatureEnabled("phone_otp_enforcement_v1");
      // effPhoneE164 (not phoneE164): the S288 test-phone exemption satisfies
      // the gate — every other number still requires the real Firebase claim.
      if (phoneOtpEnforced && !effPhoneE164) {
        recordSignupStep(supabase, uid, "phone_blocked");
        console.warn(
          "[auth/sync] Phone-OTP gate rejected userAction=" +
            (userAction ?? "(undefined)") +
            ", isNewUser=" + isNewUser +
            ", uid=" + uid,
        );
        return NextResponse.json(
          { error: "Phone verification required. Please complete the OTP step." },
          { status: 403 },
        );
      }
    }

    // Account-link case: same email, different firebase_uid. Happens when an
    // existing account is re-created (e.g., admin deleted the Firebase user but
    // the Supabase users row stuck around) or when a user adds Google sign-in
    // to an existing email-password account. We send a verification email in
    // this case if not already verified — the user effectively just "signed up
    // again" and needs to re-verify ownership of the email — but we do NOT
    // re-send the welcome email (truly-new gate only).
    const isAccountLink = !!(
      existingByEmail && existingByEmail.firebase_uid !== uid
    );

    // S315 — the typed anonymous contact: anonymous path only, shape-checked.
    // Hoisted above the branch so the consent records below can carry the
    // human's real typed address rather than the synthetic row email.
    const validContactEmail =
      isAnonToken && typeof anonContactEmail === "string" && CONTACT_EMAIL_RE.test(anonContactEmail.trim())
        ? anonContactEmail.trim().slice(0, 320)
        : null;

    let userId: string;

    if (isAccountLink) {
      // Same email, different Firebase UID — link the account by updating the UID
      console.log(`[auth/sync] Account linking: email ${email} exists with UID ${existingByEmail.firebase_uid}, updating to ${uid}`);
      const linkUpdate: Record<string, unknown> = {
        firebase_uid: uid,
        display_name: name || undefined,
        email_verified: emailVerified,
        phone_verified: effPhoneVerified,
      };
      // Only overwrite phone_e164 when Firebase token provides one — preserves
      // any value already on the row if a current signin happens to lack the
      // claim (e.g., legacy session without phone-link). eff*: the S288
      // test-phone exemption stamps/preserves the allowlisted number here.
      if (effPhoneE164) linkUpdate.phone_e164 = effPhoneE164;
      const { error: linkError } = await supabase
        .from("users")
        .update(linkUpdate)
        .eq("id", existingByEmail.id);
      if (linkError) {
        console.error("[auth/sync] Account linking failed:", linkError);
        return NextResponse.json({ error: `Account linking failed: ${linkError.message}` }, { status: 500 });
      }
      userId = existingByEmail.id;
      console.log("[auth/sync] Step 2 OK — linked to existing user:", userId);
    } else {
      // Normal upsert — new user or same UID
      // first_touch: attach only for brand-new users — the upsert also runs on
      // passive resyncs (same firebase_uid), and including it there would let a
      // later localStorage state clobber the original first touch.
      const sanitizedFirstTouch = isNewUser ? sanitizeFirstTouch(firstTouch) : null;
      const { data: upsertedUser, error: upsertError } = await supabase
        .from("users")
        .upsert(
          {
            firebase_uid: uid,
            email,
            display_name: name || null,
            email_verified: emailVerified,
            // eff*: S288 test-phone exemption — stamps the allowlisted number
            // on exempt signups AND preserves an existing stamp across passive
            // resyncs (kill switch OFF → falls back to the raw token mirror,
            // downgrading stamped rows on their next sync).
            phone_e164: effPhoneE164,
            phone_verified: effPhoneVerified,
            ...(sanitizedFirstTouch ? { first_touch: sanitizedFirstTouch } : {}),
            // S315 — mirror the token's provider truth on every sync: the
            // upgrade (linkWithCredential, same uid, non-anon token) flips it
            // false with no dedicated code path.
            is_anonymous: isAnonToken,
            ...(validContactEmail ? { contact_email: validContactEmail } : {}),
            // Upgrade transition: the real email now lives in users.email —
            // clear the anonymous-era contact channel (design §7.1).
            ...(!isAnonToken && existingByUid?.is_anonymous ? { contact_email: null } : {}),
          },
          { onConflict: "firebase_uid" }
        )
        .select("id")
        .single();

      if (upsertError || !upsertedUser) {
        console.error("[auth/sync] Failed to upsert user:", upsertError);
        return NextResponse.json({ error: `Failed to upsert user: ${upsertError?.message || "unknown"}` }, { status: 500 });
      }
      userId = upsertedUser.id;
      // Funnel (mig 206): a brand-new account exists.
      if (isNewUser) recordSignupStep(supabase, uid, "created");
      console.log("[auth/sync] Step 2 OK — user:", userId, "(email_verified=" + emailVerified + ", phone_verified=" + effPhoneVerified + (testPhoneExempt ? ", test_phone_exempt" : "") + ")");
    }

    // 2b. S316 D2 — anonymous users never run the onboarding wizard (the ONLY
    // existing profiles-row creator, POST /api/profile), so nothing ever
    // creates theirs. Downstream, the activation seams' profiles UPDATE
    // silently no-ops (0 rows matched) and parse-time claim stamping
    // (fallbackActivePlanId) reads a profile that was never there, so it's
    // permanently null. Check-then-create (not a write on every sync) mirrors
    // the Stripe-customer shape in Step 4 below — cheap on the steady-state
    // resync path. When the pointer is NULL on a non-new account, the shared
    // CF-25 repair (claim-plan-link.ts) reconciles it from insurance_plans
    // .is_active and adopts orphaned claims — heals any account whose
    // activation predated its profiles row (the pre-fix residue shape) or
    // whose seam write failed. Brand-new users can't have plans; skip.
    if (isAnonToken) {
      const { data: existingProfile } = await userScoped(supabase, userId)
        .table("profiles")
        .select("active_insurance_plan_id")
        .maybeSingle();
      if (!existingProfile) {
        const { error: profileError } = await userScoped(supabase, userId)
          .table("profiles")
          .upsert({ user_id: userId }, { onConflict: "user_id" });
        if (profileError) {
          console.error("[auth/sync] Failed to create profiles row for anonymous user:", profileError);
        } else {
          console.log("[auth/sync] Step 2b OK — profiles row created for anonymous user:", userId);
        }
      }
      if (!isNewUser && (!existingProfile || !existingProfile.active_insurance_plan_id)) {
        await repointOrphanedActivePlan(supabase, userId);
      }
    }

    // 3. Record consent events (server-side, service role bypasses RLS)
    if (consents && consents.length > 0) {
      console.log("[auth/sync] Step 3: Recording", consents.length, "consent events...");
      const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null;
      const userAgent = req.headers.get("user-agent") || null;

      const consentRows = consents.map((c) => ({
        user_id: userId,
        // S315: consent proof identifies the consenting person's own address —
        // for anonymous checks that's the typed contact, not the synthetic row
        // email.
        email: validContactEmail ?? email,
        consent_type: c.type,
        consent_version: c.version,
        consent_text_hash: c.hash,
        granted: true,
        ip_address: ip,
        user_agent: userAgent,
      }));

      const { error: consentError } = await userScoped(supabase, userId)
        .table("consent_events")
        .insert(consentRows);

      if (consentError) {
        console.error("[auth/sync] Consent insert error:", consentError);
        // Don't fail the whole sync — user is created, consent can be re-recorded
      } else {
        console.log("[auth/sync] Step 3 OK — consent recorded");
      }
    }

    // 4. Ensure Stripe Customer exists
    // S315: NOT for anonymous accounts — they can't subscribe, and minting a
    // Stripe customer per anonymous check would pollute live Stripe with
    // synthetic-email customers. The upgrade sync (non-anon token, same uid)
    // creates one through this very block.
    console.log("[auth/sync] Step 4: Checking Stripe customer...");
    const { data: stripeRecord } = isAnonToken
      ? { data: null }
      : await userScoped(supabase, userId)
          .table("stripe_customers")
          .select("stripe_customer_id")
          .single();

    let stripeCustomerId: string;

    if (isAnonToken) {
      stripeCustomerId = "";
      console.log("[auth/sync] Step 4 skipped — anonymous account has no Stripe customer");
    } else if (stripeRecord) {
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

        await userScoped(supabase, userId).table("stripe_customers").insert({
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

    // 5. Fire onboarding emails (fail-soft — Resend errors don't block signup).
    // Verification fires for new users + account-link re-signups when the
    // email isn't already verified (Google OAuth provides verified=true, so
    // those skip). Welcome email only fires for truly-new users — re-signups
    // after deletion already had a Candid account.
    const provider = decoded.firebase?.sign_in_provider;
    const alreadyVerified = decoded.email_verified === true || provider === "google.com";
    // S316 — the anonymous→full upgrade (a /check session that linked real
    // credentials through the ESTABLISHED signup flow): same uid, so it is
    // neither isNewUser nor isAccountLink, but the human just created their
    // account — verification (drives the reclaim + corroboration gates) and
    // the welcome email both apply.
    const isAnonUpgrade = !isAnonToken && existingByUid?.is_anonymous === true;
    // S315: never mail an anonymous account's synthetic address — the results
    // email (A-5) goes to contact_email at results time, not at creation.
    if ((isNewUser || isAccountLink || isAnonUpgrade) && !isAnonToken) {
      console.log(
        "[auth/sync] Step 5: Firing onboarding emails (isNewUser=" +
          isNewUser +
          ", isAccountLink=" +
          isAccountLink +
          ", alreadyVerified=" +
          alreadyVerified +
          ")"
      );
      // Await the sends so Vercel doesn't kill the function instance before
      // Resend completes. Both helpers are fail-soft (errors logged, never
      // thrown), so a Resend hiccup logs to Vercel but doesn't fail signup.
      // Adds ~500-1000ms to signup latency, acceptable in the create-account
      // mental state. Don't switch back to fire-and-forget without using
      // @vercel/functions waitUntil() — bare void Promise.allSettled is killed
      // when the response returns.
      await Promise.allSettled([
        alreadyVerified ? Promise.resolve() : sendVerificationEmail(email, name),
        isNewUser || isAnonUpgrade ? sendWelcomeEmail(email, name) : Promise.resolve(),
      ]);
    }

    // 6. Set session indicator cookie so middleware allows protected routes
    const response = NextResponse.json({
      userId,
      email,
      stripeCustomerId,
      emailVerified,
      phoneE164: effPhoneE164,
      phoneVerified: effPhoneVerified,
      // S315 — token-derived; drives the (app) layout's anonymous guard.
      isAnonymous: isAnonToken,
    });
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
