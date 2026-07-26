"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ConfirmationResult, User as FirebaseUser } from "firebase/auth";
import { useAuth } from "@/lib/auth/auth-context";
import { getConsentDocument } from "@/lib/consent/consent-documents";
import { TurnstileWidget } from "@/components/security/TurnstileWidget";
import { PhoneOTPStep } from "@/components/auth/PhoneOTPStep";
import { AuthErrorMessage } from "@/components/auth/PhoneAlreadyLinkedError";
import { SIMPLIFIED_ONBOARDING_FLAG } from "@/lib/onboarding/simplified";
import { isTestPhoneExempt, TEST_PHONE_EXEMPTION_FLAG } from "@/lib/auth/test-phone-exempt";

type SignUpMode = "form" | "otp-email" | "otp-google";

/**
 * Simplified onboarding (S285, flag `onboarding_simplified_v1`): resolve where
 * a finished signup lands. Flag ON → the 3-step /onboarding flow, with the
 * phone/dob prefill params carried over. Flag OFF — or ANY flag-read failure —
 * → today's wizard URL, byte-identical to the pre-flag behavior. Client flag
 * reads go through the public endpoint only (never browser-Supabase).
 */
async function resolvePostSignupDest(extras: { phone?: string; dob?: string }): Promise<string> {
  const legacy = new URLSearchParams({ onboarding: "true" });
  if (extras.phone) legacy.set("phone", extras.phone);
  if (extras.dob) legacy.set("dob", extras.dob);
  try {
    const res = await fetch(`/api/feature-flags/${SIMPLIFIED_ONBOARDING_FLAG}`);
    const flag = (await res.json()) as { enabled?: boolean };
    if (flag?.enabled === true) {
      const p = new URLSearchParams();
      if (extras.phone) p.set("phone", extras.phone);
      if (extras.dob) p.set("dob", extras.dob);
      const qs = p.toString();
      return qs ? `/onboarding?${qs}` : "/onboarding";
    }
  } catch {
    /* fail closed to the legacy wizard */
  }
  return `/profile?${legacy.toString()}`;
}

interface SignUpProgress {
  firebaseUser: FirebaseUser;
  phoneE164: string;
  phoneDisplay: string;
  consents: { type: string; version: string; hash: string }[];
  turnstileToken: string;
  confirmation: ConfirmationResult;
  // Tracks whether this signup recovered from an orphan (Phase 4.5).
  recoveredOrphan: boolean;
}

export default function SignUpPage() {
  const router = useRouter();
  const {
    signUpStart,
    signUpStartGoogle,
    signUpFinish,
    startPhoneVerification,
    recoverOrphanSignup,
  } = useAuth();

  // Account creation state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [tosAccepted, setTosAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountLoading, setAccountLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const [passwordErrors, setPasswordErrors] = useState<string[]>([]);

  const [mode, setMode] = useState<SignUpMode>("form");
  const [progress, setProgress] = useState<SignUpProgress | null>(null);

  const tosDoc = getConsentDocument("tos");
  const privacyDoc = getConsentDocument("privacy_policy");

  function formatPhone(value: string): string {
    const digits = value.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  function validatePassword(pw: string): string[] {
    const errors: string[] = [];
    if (pw.length < 10) errors.push("At least 10 characters");
    if (!/[A-Z]/.test(pw)) errors.push("One uppercase letter");
    if (!/[a-z]/.test(pw)) errors.push("One lowercase letter");
    if (!/[0-9]/.test(pw)) errors.push("One number");
    if (!/[^A-Za-z0-9]/.test(pw)) errors.push("One special character (!@#$%...)");
    return errors;
  }

  function handlePasswordChange(pw: string) {
    setPassword(pw);
    setPasswordErrors(pw.length > 0 ? validatePassword(pw) : []);
  }

  function buildConsents() {
    return [
      { type: "tos", version: tosDoc.version, hash: tosDoc.hash },
      { type: "privacy_policy", version: privacyDoc.version, hash: privacyDoc.hash },
    ];
  }

  async function startOtpForUser(
    firebaseUser: FirebaseUser,
    phoneE164: string,
    phoneDisplay: string,
    consents: SignUpProgress["consents"],
    token: string,
    nextMode: "otp-email" | "otp-google",
    recoveredOrphan: boolean,
  ) {
    // Test-phone exemption (S288): EXACTLY the allowlisted test number skips
    // the Firebase OTP link (Firebase enforces one-account-per-phone at
    // linkWithPhoneNumber) and is stamped verified by /api/auth/sync instead —
    // so it can exist on multiple accounts for E2E testing. The client
    // pre-checks the kill switch (fail-strict: any error → real OTP flow)
    // because a doomed sync attempt would burn the single-use Turnstile token;
    // the server re-checks authoritatively and 403s if the switch raced OFF —
    // fall through to the real OTP flow in that case.
    if (isTestPhoneExempt(phoneE164)) {
      let exemptionOn = false;
      try {
        const res = await fetch(`/api/feature-flags/${TEST_PHONE_EXEMPTION_FLAG}`);
        const flag = (await res.json()) as { enabled?: boolean };
        exemptionOn = flag?.enabled === true;
      } catch {
        exemptionOn = false;
      }
      if (exemptionOn) {
        try {
          await signUpFinish(firebaseUser, consents, token, phoneE164);
          // Mirrors handleOtpVerified routing (email path carries phone+DOB).
          if (nextMode === "otp-email") {
            router.push(
              await resolvePostSignupDest({
                phone: phoneE164.replace(/^\+1/, ""),
                dob: dateOfBirth || undefined,
              }),
            );
          } else {
            router.push(await resolvePostSignupDest({}));
          }
          return;
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code !== "auth/phone-verification-required") throw err;
          // Kill switch raced OFF server-side — continue into the real OTP flow.
        }
      }
    }
    const confirmation = await startPhoneVerification(firebaseUser, phoneE164);
    setProgress({
      firebaseUser,
      phoneE164,
      phoneDisplay,
      consents,
      turnstileToken: token,
      confirmation,
      recoveredOrphan,
    });
    setMode(nextMode);
  }

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!fullName.trim() || fullName.trim().split(/\s+/).length < 2) {
      setAccountError("Please enter your full legal name (first and last).");
      return;
    }
    const phoneDigits = phone.replace(/\D/g, "");
    if (!phoneDigits || phoneDigits.length !== 10) {
      setAccountError("Please enter a valid 10-digit US phone number.");
      return;
    }
    if (!dateOfBirth) {
      setAccountError("Date of birth is required.");
      return;
    }
    const [dobYear, dobMonth, dobDay] = dateOfBirth.split("-").map(Number);
    if (!dobYear || !dobMonth || !dobDay || dobYear < 1900 || dobYear > new Date().getFullYear()) {
      setAccountError("Please enter a valid date of birth.");
      return;
    }
    const now = new Date();
    const age = now.getFullYear() - dobYear - (now.getMonth() + 1 < dobMonth || (now.getMonth() + 1 === dobMonth && now.getDate() < dobDay) ? 1 : 0);
    if (age < 18) {
      setAccountError("You must be at least 18 years old to use Candid.");
      return;
    }
    if (!tosAccepted || !privacyAccepted) {
      setAccountError("You must accept both the Terms of Service and Privacy Policy.");
      return;
    }
    if (!turnstileToken) {
      setAccountError("Please check 'Verify you are human' above to continue.");
      return;
    }
    const pwErrors = validatePassword(password);
    if (pwErrors.length > 0) {
      setPasswordErrors(pwErrors);
      setAccountError("Please fix the password requirements below.");
      return;
    }

    setAccountLoading(true);
    setAccountError("");
    const phoneE164 = `+1${phoneDigits}`;
    const phoneDisplay = formatPhone(phoneDigits);
    const consents = buildConsents();

    try {
      const firebaseUser = await signUpStart(email, password, fullName);
      await startOtpForUser(
        firebaseUser,
        phoneE164,
        phoneDisplay,
        consents,
        turnstileToken,
        "otp-email",
        false,
      );
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/email-already-in-use") {
        // R8 orphan recovery — Firebase user exists. Try the password they
        // just typed; if it works AND no phone linked yet, resume OTP step.
        // If password mismatches, route to /auth/signin where they can use
        // forgot-password if they need.
        try {
          const fbUser = await recoverOrphanSignup(email, password);
          if (!fbUser.phoneNumber) {
            await startOtpForUser(
              fbUser,
              phoneE164,
              phoneDisplay,
              consents,
              turnstileToken,
              "otp-email",
              true,
            );
            return;
          }
          // Already fully signed-up — push them to dashboard via a clean signin.
          router.push("/dashboard");
          return;
        } catch {
          router.push("/auth/signin?existing=true&email=" + encodeURIComponent(email));
          return;
        }
      } else if (code === "auth/invalid-email") {
        setAccountError("Please enter a valid email address.");
      } else if (code === "auth/weak-password") {
        setAccountError("Password is too weak. Please use a stronger password.");
      } else if (code === "auth/turnstile-failed") {
        setAccountError("Bot defense check failed. Please reload the page and try again.");
      } else if (
        code === "auth/credential-already-in-use" ||
        code === "auth/account-exists-with-different-credential"
      ) {
        // Phone X already linked to a different Firebase user. Fires from
        // startPhoneVerification (linkWithPhoneNumber) BEFORE the OTP UI
        // renders. Firebase user from signUpStart is now an orphan; if the
        // user retries with a different phone, R8 orphan recovery picks up.
        setAccountError(
          "This phone number is already linked to another Candid account. Please use a different number.",
        );
      } else {
        setAccountError("Failed to create account. Please try again.");
      }
    } finally {
      setAccountLoading(false);
    }
  }

  const [showGoogleConsent, setShowGoogleConsent] = useState(false);
  const [googleTos, setGoogleTos] = useState(false);
  const [googlePrivacy, setGooglePrivacy] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const [googlePhonePrompt, setGooglePhonePrompt] = useState<{
    firebaseUser: FirebaseUser;
    consents: SignUpProgress["consents"];
    turnstileToken: string;
  } | null>(null);
  const [googlePhoneInput, setGooglePhoneInput] = useState("");
  const [googleStartLoading, setGoogleStartLoading] = useState(false);

  async function handleGoogle() {
    if (tosAccepted && privacyAccepted) {
      return doGoogleSignIn();
    }
    setShowGoogleConsent(true);
  }

  async function doGoogleSignIn() {
    if (!turnstileToken) {
      setAccountError("Please check 'Verify you are human' above to continue.");
      return;
    }
    setGoogleLoading(true);
    setGoogleError("");
    try {
      const consents = buildConsents();
      const firebaseUser = await signUpStartGoogle();
      if (firebaseUser.phoneNumber) {
        // Google account already has a linked phone — finish straight away.
        await signUpFinish(firebaseUser, consents, turnstileToken);
        router.push(await resolvePostSignupDest({}));
        return;
      }
      // Need phone OTP step before sync. Prompt for phone inline.
      setGooglePhonePrompt({ firebaseUser, consents, turnstileToken });
      setShowGoogleConsent(false);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/turnstile-failed") {
        setAccountError("Bot defense check failed. Please reload the page and try again.");
      } else {
        setAccountError("Google sign-up failed");
      }
    } finally {
      setGoogleLoading(false);
    }
  }

  async function handleGooglePhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!googlePhonePrompt) return;
    const phoneDigits = googlePhoneInput.replace(/\D/g, "");
    if (!phoneDigits || phoneDigits.length !== 10) {
      setGoogleError("Please enter a valid 10-digit US phone number.");
      return;
    }
    setGoogleStartLoading(true);
    setGoogleError("");
    try {
      const phoneE164 = `+1${phoneDigits}`;
      const phoneDisplay = formatPhone(phoneDigits);
      await startOtpForUser(
        googlePhonePrompt.firebaseUser,
        phoneE164,
        phoneDisplay,
        googlePhonePrompt.consents,
        googlePhonePrompt.turnstileToken,
        "otp-google",
        false,
      );
      setGooglePhonePrompt(null);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (
        code === "auth/credential-already-in-use" ||
        code === "auth/account-exists-with-different-credential"
      ) {
        setGoogleError(
          "This phone number is already linked to another Candid account. Please use a different number.",
        );
      } else {
        setGoogleError("Couldn't send the verification code. Please check the number and try again.");
      }
    } finally {
      setGoogleStartLoading(false);
    }
  }

  async function handleOtpVerified() {
    if (!progress) return;
    try {
      await signUpFinish(progress.firebaseUser, progress.consents, progress.turnstileToken);

      // Email/password path includes phone+DOB params for the onboarding flow;
      // Google path goes straight to onboarding (no extra params).
      if (mode === "otp-email") {
        router.push(
          await resolvePostSignupDest({
            phone: progress.phoneE164.replace(/^\+1/, ""),
            dob: dateOfBirth || undefined,
          }),
        );
      } else {
        router.push(await resolvePostSignupDest({}));
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/turnstile-failed") {
        setAccountError(
          "Bot defense check failed. Please reload the page and try signup again.",
        );
        setMode("form");
        setProgress(null);
      } else {
        setAccountError("Couldn't finish your signup. Please try again.");
      }
    }
  }

  async function handleOtpResend() {
    if (!progress) {
      throw new Error("No signup in progress");
    }
    return await startPhoneVerification(progress.firebaseUser, progress.phoneE164);
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4 bg-white">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link href="/" className="text-2xl font-bold text-blue-600">
            Candid
          </Link>
        </div>

        {mode === "form" && (
          <>
            <div className="text-center">
              <h1 className="text-2xl font-bold text-gray-900">
                Create your account
              </h1>
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">
                Set up your profile and upload your bills to get started with Candid.
              </p>
            </div>

            <button
              onClick={handleGoogle}
              disabled={googleLoading}
              className="w-full py-3 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 font-medium flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              {googleLoading ? "Connecting..." : "Continue with Google"}
            </button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white text-gray-500">or</span>
              </div>
            </div>

            <form onSubmit={handleCreateAccount} className="space-y-4">
              <div>
                <label htmlFor="signup-name" className="text-xs font-medium text-gray-600 mb-1 block">
                  Full legal name <span className="text-red-400">*</span>
                </label>
                <input
                  id="signup-name"
                  type="text"
                  required
                  autoComplete="name"
                  placeholder="First and last name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label htmlFor="signup-email" className="text-xs font-medium text-gray-600 mb-1 block">
                  Email <span className="text-red-400">*</span>
                </label>
                <input
                  id="signup-email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label htmlFor="signup-phone" className="text-xs font-medium text-gray-600 mb-1 block">
                  Phone number <span className="text-red-400">*</span>
                </label>
                <input
                  id="signup-phone"
                  type="tel"
                  required
                  autoComplete="tel-national"
                  placeholder="(555) 123-4567"
                  value={phone}
                  onChange={(e) => setPhone(formatPhone(e.target.value))}
                  className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-400 mt-1">
                  We&apos;ll text a one-time code to verify it. US numbers only.
                </p>
              </div>
              <div>
                <label htmlFor="signup-dob" className="text-xs font-medium text-gray-600 mb-1 block">
                  Date of birth <span className="text-red-400">*</span>
                </label>
                <input
                  id="signup-dob"
                  type="date"
                  required
                  autoComplete="off"
                  value={dateOfBirth}
                  max={new Date(new Date().setFullYear(new Date().getFullYear() - 18)).toISOString().split("T")[0]}
                  min="1920-01-01"
                  onChange={(e) => setDateOfBirth(e.target.value)}
                  className={`w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${dateOfBirth ? "text-gray-900" : "text-gray-400"}`}
                />
                <p className="text-xs text-gray-400 mt-1">Must be 18 or older</p>
              </div>
              <div>
                <label htmlFor="signup-password" className="text-xs font-medium text-gray-600 mb-1 block">
                  Password <span className="text-red-400">*</span>
                </label>
                <input
                  id="signup-password"
                  type="password"
                  required
                  minLength={10}
                  autoComplete="new-password"
                  placeholder="10+ characters"
                  value={password}
                  onChange={(e) => handlePasswordChange(e.target.value)}
                  className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                    password.length > 0 && passwordErrors.length > 0
                      ? "border-red-300"
                      : "border-gray-200"
                  }`}
                />
              </div>
              {password.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {[
                    { label: "At least 10 characters", test: password.length >= 10 },
                    { label: "One uppercase letter", test: /[A-Z]/.test(password) },
                    { label: "One lowercase letter", test: /[a-z]/.test(password) },
                    { label: "One number", test: /[0-9]/.test(password) },
                    { label: "One special character (!@#$%...)", test: /[^A-Za-z0-9]/.test(password) },
                  ].map((rule) => (
                    <li key={rule.label} className={rule.test ? "text-green-600" : "text-gray-400"}>
                      {rule.test ? "✓" : "○"} {rule.label}
                    </li>
                  ))}
                </ul>
              )}

              <div className="space-y-3 p-4 bg-gray-50 rounded-lg">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tosAccepted}
                    onChange={(e) => setTosAccepted(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    I have read and agree to the{" "}
                    <Link href="/terms" target="_blank" className="text-blue-600 hover:underline">
                      Terms of Service
                    </Link>{" "}
                    (v{tosDoc.version})
                  </span>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={privacyAccepted}
                    onChange={(e) => setPrivacyAccepted(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    I have read and agree to the{" "}
                    <Link href="/privacy" target="_blank" className="text-blue-600 hover:underline">
                      Privacy Policy
                    </Link>{" "}
                    (v{privacyDoc.version})
                  </span>
                </label>
              </div>

              <TurnstileWidget action="signup" onToken={setTurnstileToken} />

              <button
                type="submit"
                disabled={accountLoading || !tosAccepted || !privacyAccepted || !turnstileToken || (password.length > 0 && passwordErrors.length > 0)}
                className="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-semibold"
              >
                {accountLoading ? "Creating account..." : "Create Account"}
              </button>
            </form>

            <AuthErrorMessage error={accountError} />

            <div className="text-center space-y-2">
              <p className="text-sm text-gray-500">
                Already have an account?{" "}
                <Link href="/auth/signin" className="text-blue-600 hover:underline font-medium">
                  Sign in
                </Link>
              </p>
            </div>

            <p className="text-xs text-gray-400 text-center">
              Candid is an Airgetlam Labs LLC company.
            </p>
          </>
        )}

        {(mode === "otp-email" || mode === "otp-google") && progress && (
          <div className="space-y-6">
            {progress.recoveredOrphan && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-sm text-blue-800 font-medium">Welcome back</p>
                <p className="text-sm text-blue-700 mt-1">
                  We found your half-finished signup. Just verify your phone to wrap up.
                </p>
              </div>
            )}
            <PhoneOTPStep
              phoneE164={progress.phoneE164}
              phoneDisplay={progress.phoneDisplay}
              confirmationResult={progress.confirmation}
              onVerified={handleOtpVerified}
              onResend={handleOtpResend}
            />
            <AuthErrorMessage error={accountError} />
          </div>
        )}
      </div>

      {/* ── Google consent popup ─────────────────────────────────────────── */}
      {showGoogleConsent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Before you continue</h3>
            <p className="text-sm text-gray-600">
              Please review and accept our Terms of Service and Privacy Policy to create your account.
            </p>

            <div className="space-y-3 p-4 bg-gray-50 rounded-xl">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={googleTos}
                  onChange={(e) => setGoogleTos(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">
                  I agree to the{" "}
                  <Link href="/terms" target="_blank" className="text-blue-600 hover:underline">
                    Terms of Service
                  </Link>{" "}
                  (v{tosDoc.version})
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={googlePrivacy}
                  onChange={(e) => setGooglePrivacy(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">
                  I agree to the{" "}
                  <Link href="/privacy" target="_blank" className="text-blue-600 hover:underline">
                    Privacy Policy
                  </Link>{" "}
                  (v{privacyDoc.version})
                </span>
              </label>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { setShowGoogleConsent(false); setGoogleTos(false); setGooglePrivacy(false); }}
                className="flex-1 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setTosAccepted(true);
                  setPrivacyAccepted(true);
                  doGoogleSignIn();
                }}
                disabled={!googleTos || !googlePrivacy || googleLoading}
                className="flex-1 py-2.5 text-sm bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 font-semibold"
              >
                {googleLoading ? "Connecting..." : "Continue"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Google phone-collection popup (no phoneNumber on Google account) ── */}
      {googlePhonePrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-gray-900">One more step</h3>
            <p className="text-sm text-gray-600">
              We text a one-time code to verify it&apos;s really you. US phone numbers only.
            </p>
            <form onSubmit={handleGooglePhoneSubmit} className="space-y-4">
              <input
                type="tel"
                required
                autoComplete="tel-national"
                placeholder="(555) 123-4567"
                value={googlePhoneInput}
                onChange={(e) => setGooglePhoneInput(formatPhone(e.target.value))}
                className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <AuthErrorMessage error={googleError} className="text-red-600 text-sm" />
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => { setGooglePhonePrompt(null); setGooglePhoneInput(""); setGoogleError(""); }}
                  className="flex-1 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={googleStartLoading}
                  className="flex-1 py-2.5 text-sm bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 font-semibold"
                >
                  {googleStartLoading ? "Sending…" : "Send code"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
