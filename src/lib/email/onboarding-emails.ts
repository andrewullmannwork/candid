/**
 * Transactional email helpers for first-time-user onboarding +
 * post-parse async ingestion notification (S78).
 * All functions are fail-soft: a Resend failure logs but does not throw,
 * so signup / parse-completion never block on email delivery.
 */

import { Resend } from "resend";
import { getAdminAuth } from "@/lib/firebase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.candidclaim.com";
const FROM = "Candid <noreply@candidclaim.com>";

// S78 / Cost-H.2 (S198) — the parse-complete email fires for the EMAIL tier
// (pageCount > ASYNC_EMAIL_MAX_PAGES, default 30), read from flags in
// sendParseCompleteEmail. Docs in the lower async "redirect" tier (the future
// 15-30 band) take the splash + in-app banner but get NO email.

function getResend(): Resend | null {
  return process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
}

function firstNameOf(displayName: string | null | undefined): string {
  if (!displayName) return "there";
  const first = displayName.trim().split(/\s+/)[0];
  return first || "there";
}

/**
 * Send a Firebase-generated email-verification link via Resend.
 * Skipped silently if Resend is not configured.
 * Caller decides whether to fire (e.g., skip for Google OAuth users with
 * already-verified email).
 */
export async function sendVerificationEmail(
  email: string,
  displayName?: string | null
): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.warn("[onboarding-emails] RESEND_API_KEY missing — skipping verification email");
    return;
  }

  let verifyLink: string;
  try {
    // continueUrl points at our Candid-styled action handler so the user lands
    // on a Candid success card after Firebase processes the action. To FULLY
    // bypass the generic Firebase action page (the brief "Your email has been
    // verified" Firebase-branded screen with a CONTINUE button), update
    // Firebase Console → Authentication → Templates → "Customize action URL"
    // to https://www.candidclaim.com/auth/action — the multi-mode handler at
    // /auth/action processes the oobCode itself, no Firebase intermediate.
    verifyLink = await getAdminAuth().generateEmailVerificationLink(email, {
      url: `${APP_URL}/auth/action`,
    });
  } catch (err) {
    console.error("[onboarding-emails] generateEmailVerificationLink failed:", err);
    return;
  }

  const greeting = firstNameOf(displayName);

  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: "Verify your Candid email address",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; font-weight: 700; color: #1d4ed8; margin: 0;">Candid</h1>
          </div>

          <h2 style="font-size: 20px; font-weight: 600; color: #111827; margin: 0 0 12px;">Verify your email</h2>

          <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 24px;">
            Hi ${greeting} — thanks for signing up for Candid. Tap the button below to confirm this is your email address.
          </p>

          <div style="text-align: center; margin: 32px 0;">
            <a href="${verifyLink}" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 10px;">
              Verify Email
            </a>
          </div>

          <p style="font-size: 13px; color: #9ca3af; line-height: 1.5; margin: 0 0 8px;">
            Or copy this link into your browser:
          </p>
          <p style="font-size: 12px; color: #6b7280; word-break: break-all; margin: 0 0 32px;">
            ${verifyLink}
          </p>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

          <p style="font-size: 13px; color: #9ca3af; line-height: 1.5; margin: 0;">
            If you didn&rsquo;t create a Candid account, you can safely ignore this email.
          </p>

          <p style="font-size: 12px; color: #d1d5db; margin: 24px 0 0; text-align: center;">
            From, The Candid Team<br />
            Candid is an Airgetlam Labs LLC company.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.error("[onboarding-emails] Resend verification send failed:", err);
  }
}

/**
 * Send the welcome email on first-time signup.
 * Fail-soft: a Resend error is logged but does not block the signup flow.
 */
export async function sendWelcomeEmail(
  email: string,
  displayName?: string | null
): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.warn("[onboarding-emails] RESEND_API_KEY missing — skipping welcome email");
    return;
  }

  const greeting = firstNameOf(displayName);

  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: "Welcome to Candid",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; font-weight: 700; color: #1d4ed8; margin: 0;">Candid</h1>
          </div>

          <h2 style="font-size: 20px; font-weight: 600; color: #111827; margin: 0 0 12px;">Welcome, ${greeting}.</h2>

          <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 16px;">
            Candid creates certainty about healthcare costs. Upload your insurance card and plan documents and we&rsquo;ll show you what you&rsquo;re actually covered for, audit your bills for errors, and help you dispute overcharges.
          </p>

          <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 24px;">
            To get the most out of Candid, your next step is to set up your profile and upload an insurance card or plan document.
          </p>

          <div style="text-align: center; margin: 32px 0;">
            <a href="${APP_URL}/profile?onboarding=true" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 10px;">
              Set up your profile
            </a>
          </div>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

          <p style="font-size: 13px; color: #9ca3af; line-height: 1.5; margin: 0 0 8px;">
            Questions? Just reply to this email and we&rsquo;ll get back to you.
          </p>

          <p style="font-size: 12px; color: #d1d5db; margin: 24px 0 0; text-align: center;">
            From, The Candid Team<br />
            Candid is an Airgetlam Labs LLC company.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.error("[onboarding-emails] Resend welcome send failed:", err);
  }
}

/**
 * S78 — async ingestion: send the parse-complete email after a large plan_doc
 * finishes async processing in the background. Fail-soft (Resend failure logs
 * but doesn't throw + doesn't block the parse pipeline). Idempotent by
 * `idempotencyKey: parse-complete:{documentId}` so QStash retries of the
 * upstream process-chunk endpoint never trigger a duplicate send.
 *
 * Guardrails:
 *   - Only fires when `processing_total_pages > ASYNC_EMAIL_MAX_PAGES` (flag,
 *     default 30 — the email tier). Small documents already finish during the
 *     sync PlayfulParsingScreen flow and don't need a separate completion email.
 *   - Looks up the user's verified email via Firebase admin SDK (so we can
 *     send even when the user's session has expired).
 *   - Skipped silently if Resend isn't configured (local dev without RESEND_API_KEY).
 *
 * Caller pattern (process-chunk + process-plan success exit):
 *   await sendParseCompleteEmail(supabase, documentId);
 *   // Fire-and-forget; status='processed' has already been set on the doc.
 */
export async function sendParseCompleteEmail(
  supabase: SupabaseClient,
  documentId: string,
): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.warn("[onboarding-emails] RESEND_API_KEY missing — skipping parse-complete email");
    return;
  }

  // S78 — gate behind feature flag. When OFF (default in dev), no parse-complete
  // emails fire. Dynamic import keeps this helper usable from contexts that
  // don't statically import the flag system (e.g., process-plan.ts).
  try {
    const { isFeatureEnabled } = await import("@/lib/config/product-flags");
    const enabled = await isFeatureEnabled("async_ingestion_ux_v1");
    if (!enabled) return;
  } catch (err) {
    console.warn("[onboarding-emails] parse-complete: flag check failed (skipping send):", err);
    return;
  }

  // Fetch the document + owning user in a single round-trip.
  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .select("id, user_id, file_name, processing_total_pages, status, users(firebase_uid, email_verified)")
    .eq("id", documentId)
    .single();

  if (docErr || !doc) {
    console.warn(
      `[onboarding-emails] parse-complete: doc lookup failed for ${documentId}:`,
      docErr?.message ?? "no doc",
    );
    return;
  }

  // Only fire for the EMAIL tier — Cost-H.2 (S198): the redirect tier (async
  // splash) is wider than the email tier, so docs in the future 15-30 band get
  // the in-app banner, not an email. Flag-tunable, default 30.
  const { getFlags } = await import("@/lib/config/feature-flags");
  const emailThresholdPages = (await getFlags()).ASYNC_EMAIL_MAX_PAGES;
  const pageCount = typeof doc.processing_total_pages === "number" ? doc.processing_total_pages : 0;
  if (pageCount <= emailThresholdPages) {
    return; // sub-email-tier docs use the sync screen or in-app banner; no email
  }

  if (doc.status !== "processed") {
    console.warn(
      `[onboarding-emails] parse-complete: doc ${documentId} not 'processed' (status=${doc.status}) — skipping send`,
    );
    return;
  }

  // Pull user's email via Firebase (Supabase users row only stores verification
  // state + firebase_uid, not the raw email).
  const userRow = Array.isArray(doc.users) ? doc.users[0] : doc.users;
  const firebaseUid = userRow?.firebase_uid as string | undefined;
  if (!firebaseUid) {
    console.warn(`[onboarding-emails] parse-complete: missing firebase_uid for doc ${documentId}`);
    return;
  }

  let userRecord: { email?: string | null; displayName?: string | null } | null = null;
  try {
    const fbUser = await getAdminAuth().getUser(firebaseUid);
    userRecord = { email: fbUser.email ?? null, displayName: fbUser.displayName ?? null };
  } catch (err) {
    console.warn(
      `[onboarding-emails] parse-complete: Firebase getUser failed for ${firebaseUid}:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (!userRecord?.email) {
    console.warn(`[onboarding-emails] parse-complete: no email on Firebase user ${firebaseUid}`);
    return;
  }

  const greeting = firstNameOf(userRecord.displayName);
  const fileName = typeof doc.file_name === "string" ? doc.file_name : "your plan document";
  const planUrl = `${APP_URL}/plan`;

  try {
    await resend.emails.send(
      {
        from: FROM,
        to: userRecord.email,
        subject: `Your ${fileName} is ready on Candid`,
        html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; font-weight: 700; color: #1d4ed8; margin: 0;">Candid</h1>
          </div>

          <h2 style="font-size: 20px; font-weight: 600; color: #111827; margin: 0 0 12px;">Great news, ${greeting} — your plan is ready.</h2>

          <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 16px;">
            We&rsquo;ve finished reading every page of <strong>${fileName}</strong> — copays, deductibles, prior-auth quirks, the works.
          </p>

          <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 24px;">
            Hop back in and take a look at what your plan actually covers.
          </p>

          <div style="text-align: center; margin: 32px 0;">
            <a href="${planUrl}" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 10px;">
              See your plan
            </a>
          </div>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

          <p style="font-size: 13px; color: #9ca3af; line-height: 1.5; margin: 0 0 8px;">
            Questions? Just reply to this email and we&rsquo;ll get back to you.
          </p>

          <p style="font-size: 12px; color: #d1d5db; margin: 24px 0 0; text-align: center;">
            From, The Candid Team<br />
            Candid is an Airgetlam Labs LLC company.
          </p>
        </div>
      `,
      },
      {
        idempotencyKey: `parse-complete:${documentId}`,
      },
    );
  } catch (err) {
    console.error("[onboarding-emails] Resend parse-complete send failed:", err);
  }
}

/**
 * S316 A-5 — the anonymous /check results email, sent ONLY on the user's
 * explicit "Email me my results" click (one-shot; the copy promises no
 * follow-up and none is scheduled). Goes to users.contact_email — the address
 * the person typed "for your results" — never the synthetic anon row email.
 * Every dollar renders with the "up to / in question" hedge (S252 UDAP rule:
 * no consumer-visible recovery number without an estimate qualifier).
 * Returns true when Resend accepted the send (drives the route's 200/502).
 */
export async function sendCheckResultsEmail(
  email: string,
  params: {
    providerName: string | null;
    billedTotal: number | null;
    serviceDate: string | null;
    /** The screen's claim-level recovery + plan-share pair (live engine, via
     *  the client's own rendered payload) — the email leads with the same
     *  banner sentence the results page shows. Null → no recovery banner. */
    recoveryTotal: number | null;
    shouldOwe: number | null;
    /** S318 — priced-lines floor + unpriced count; when count > 0 the share
     *  sentence renders as the approved floor–ceiling range. */
    pricedFloor?: number | null;
    unpricedCount?: number;
    findings: { label: string; amount: number | null }[];
    /** Caller-built (content-aware): identical results dedupe at Resend,
     *  changed results re-send. */
    idempotencyKey: string;
  }
): Promise<boolean> {
  const resend = getResend();
  if (!resend) {
    console.warn("[onboarding-emails] RESEND_API_KEY missing — skipping check-results email");
    return false;
  }

  const { providerName, billedTotal, serviceDate, recoveryTotal, shouldOwe, pricedFloor, unpricedCount, findings, idempotencyKey } = params;
  const signupUrl = `${APP_URL}/auth/signup`;

  const headerBits = [
    providerName,
    billedTotal != null ? `billed $${billedTotal.toFixed(2)}` : null,
    serviceDate,
  ].filter(Boolean);

  // The results page's banner sentence, verbatim structure ("You may be able
  // to recover…"), hedged per the standing UDAP rule. chargedYou is derived
  // the same way the page derives it: plan share + recovery.
  const hasRecovery = recoveryTotal != null && recoveryTotal >= 1;
  const recoveryBanner = hasRecovery
    ? `
            <p style="font-size: 15px; font-weight: 600; color: #166534; margin: 0 0 4px;">
              You may be able to recover up to $${recoveryTotal.toFixed(2)}
            </p>
            ${
              shouldOwe != null
                ? `<p style="font-size: 13px; color: #4b5563; line-height: 1.55; margin: 0 0 12px;">
              ${
                (unpricedCount ?? 0) > 0 && pricedFloor != null
                  ? // S318 (Andrew-approved range sentence; the confirm ask lives
                    // on the results page the button below opens)
                    `This bill charges you $${(shouldOwe + recoveryTotal).toFixed(2)}. Your plan puts your share at $${pricedFloor.toFixed(2)}&ndash;$${shouldOwe.toFixed(2)}.`
                  : `Your plan puts your share around $${shouldOwe.toFixed(2)}, but this bill charges you $${(shouldOwe + recoveryTotal).toFixed(2)}.`
              }
            </p>`
                : ""
            }`
    : "";

  const findingLines =
    findings.length > 0
      ? findings
          .map(
            (f) => `
            <p style="font-size: 14px; color: #111827; line-height: 1.6; margin: 0 0 6px;">
              &middot; ${f.label}${f.amount != null && f.amount >= 1 ? ` &mdash; up to $${f.amount.toFixed(2)} in question` : ""}
            </p>`
          )
          .join("")
      : hasRecovery
        ? ""
        : `
            <p style="font-size: 14px; color: #111827; line-height: 1.6; margin: 0;">
              Nothing stood out on this bill against the documents you provided &mdash; that&rsquo;s a good check.
            </p>`;

  try {
    await resend.emails.send(
      {
        from: FROM,
        to: email,
        subject: "Your bill check results",
        html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; font-weight: 700; color: #1d4ed8; margin: 0;">Candid</h1>
          </div>

          <h2 style="font-size: 20px; font-weight: 600; color: #111827; margin: 0 0 12px;">Your bill check results</h2>

          <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 16px;">
            Hi there &mdash; here&rsquo;s what we found on the bill you checked, kept for your records.
          </p>

          <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin: 0 0 16px;">
            ${headerBits.length > 0 ? `<p style="font-size: 13px; color: #6b7280; margin: 0 0 10px;">${headerBits.join(" &middot; ")}</p>` : ""}
            ${recoveryBanner}
            ${findingLines}
          </div>

          <p style="font-size: 13px; color: #6b7280; line-height: 1.55; margin: 0 0 24px;">
            Amounts are estimates based on the documents you uploaded and may not reflect your complete plan terms. Always verify with your insurer.
          </p>

          <div style="text-align: center; margin: 0 0 12px;">
            <a href="${signupUrl}" style="display: inline-block; padding: 12px 28px; background-color: #2563eb; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 10px;">
              Turn this into a dispute letter
            </a>
          </div>

          <p style="font-size: 13px; color: #6b7280; line-height: 1.55; text-align: center; margin: 0 0 24px;">
            Sign up with this same email address and after you verify it, we&rsquo;ll offer to bring this check into your account.
          </p>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 16px;" />

          <p style="font-size: 12px; color: #9ca3af; line-height: 1.5; margin: 0 0 8px;">
            You asked for this one email on the check page. We won&rsquo;t send another. To have this check erased, reply &ldquo;delete&rdquo; or write privacy@candidclaim.com.
          </p>

          <p style="font-size: 12px; color: #d1d5db; margin: 24px 0 0; text-align: center;">
            From, The Candid Team<br />
            Candid is an Airgetlam Labs LLC company.
          </p>
        </div>
      `,
      },
      {
        idempotencyKey,
      }
    );
    return true;
  } catch (err) {
    console.error("[onboarding-emails] Resend check-results send failed:", err);
    return false;
  }
}
