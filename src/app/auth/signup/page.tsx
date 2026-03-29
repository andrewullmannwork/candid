"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { getConsentDocument } from "@/lib/consent/consent-documents";

export default function SignUpPage() {
  const router = useRouter();
  const { signUpWithEmail, signInWithGoogle } = useAuth();
  const [step, setStep] = useState<"waitlist" | "create-account">("waitlist");

  // Waitlist state
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistSubmitted, setWaitlistSubmitted] = useState(false);
  const [waitlistError, setWaitlistError] = useState("");
  const [waitlistLoading, setWaitlistLoading] = useState(false);

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

  const [passwordErrors, setPasswordErrors] = useState<string[]>([]);

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

  async function handleWaitlist(e: React.FormEvent) {
    e.preventDefault();
    setWaitlistLoading(true);
    setWaitlistError("");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: waitlistEmail }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Something went wrong");
      }

      setWaitlistSubmitted(true);
      setEmail(waitlistEmail);
    } catch (err) {
      setWaitlistError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setWaitlistLoading(false);
    }
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
    const dob = new Date(dateOfBirth);
    const eighteenYearsAgo = new Date();
    eighteenYearsAgo.setFullYear(eighteenYearsAgo.getFullYear() - 18);
    if (dob > eighteenYearsAgo) {
      setAccountError("You must be at least 18 years old to use Candid.");
      return;
    }
    if (!tosAccepted || !privacyAccepted) {
      setAccountError("You must accept both the Terms of Service and Privacy Policy.");
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
    try {
      // Pass consent info through the auth flow — recorded server-side in /api/auth/sync
      const consents = [
        { type: "tos", version: tosDoc.version, hash: tosDoc.hash },
        { type: "privacy_policy", version: privacyDoc.version, hash: privacyDoc.hash },
      ];
      await signUpWithEmail(email, password, consents, fullName);

      // Send to profile with phone and DOB pre-set for the onboarding flow
      const params = new URLSearchParams({ onboarding: "true" });
      if (phone) params.set("phone", phone.replace(/\D/g, ""));
      if (dateOfBirth) params.set("dob", dateOfBirth);
      router.push(`/profile?${params.toString()}`);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/email-already-in-use") {
        // Redirect to sign-in with a message
        router.push("/auth/signin?existing=true&email=" + encodeURIComponent(email));
        return;
      } else if (code === "auth/invalid-email") {
        setAccountError("Please enter a valid email address.");
      } else if (code === "auth/weak-password") {
        setAccountError("Password is too weak. Please use a stronger password.");
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

  async function handleGoogle() {
    // If consent already given via the form checkboxes, proceed directly
    if (tosAccepted && privacyAccepted) {
      return doGoogleSignIn();
    }
    // Otherwise show inline consent popup
    setShowGoogleConsent(true);
  }

  async function doGoogleSignIn() {
    setGoogleLoading(true);
    try {
      const consents = [
        { type: "tos", version: tosDoc.version, hash: tosDoc.hash },
        { type: "privacy_policy", version: privacyDoc.version, hash: privacyDoc.hash },
      ];
      await signInWithGoogle(consents);
      router.push("/profile?onboarding=true");
    } catch {
      setAccountError("Google sign-up failed");
    } finally {
      setGoogleLoading(false);
      setShowGoogleConsent(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4 bg-white">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link href="/" className="text-2xl font-bold text-blue-600">
            Candid
          </Link>
        </div>

        {/* Step 1: Waitlist */}
        {step === "waitlist" && !waitlistSubmitted && (
          <>
            <div className="text-center">
              <h1 className="text-2xl font-bold text-gray-900">
                We&apos;re currently invite-only
              </h1>
              <p className="mt-3 text-gray-500 leading-relaxed">
                Candid is in early access. Join the waitlist and we&apos;ll get you in as soon as possible.
              </p>
            </div>

            <form onSubmit={handleWaitlist} className="space-y-4">
              <input
                type="email"
                required
                placeholder="Enter your email"
                value={waitlistEmail}
                onChange={(e) => setWaitlistEmail(e.target.value)}
                className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                type="submit"
                disabled={waitlistLoading}
                className="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-semibold shadow-lg shadow-blue-600/20"
              >
                {waitlistLoading ? "Joining..." : "Join the Waitlist"}
              </button>
            </form>

            {waitlistError && <p className="text-red-600 text-sm text-center">{waitlistError}</p>}
          </>
        )}

        {/* Step 1.5: Waitlist confirmed — offer head start */}
        {step === "waitlist" && waitlistSubmitted && (
          <>
            <div className="p-5 bg-green-50 border border-green-200 rounded-xl text-center">
              <div className="text-lg font-semibold text-green-800 mb-1">You&apos;re on the list!</div>
              <p className="text-sm text-green-700">
                We&apos;ll send you an invite as soon as a spot opens up.
              </p>
            </div>

            <div className="p-5 bg-blue-50 border border-blue-200 rounded-xl">
              <h3 className="font-semibold text-blue-900 text-center">Want a head start?</h3>
              <p className="mt-2 text-sm text-blue-700 text-center leading-relaxed">
                Create your account now, fill out your profile, and upload your medical bills so
                everything is ready when you get access.
              </p>
              <p className="mt-3 text-xs text-blue-600 text-center font-medium">
                Completed profiles may be approved more quickly.
              </p>
              <button
                onClick={() => setStep("create-account")}
                className="w-full mt-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold shadow-lg shadow-blue-600/20"
              >
                Get a Head Start
              </button>
            </div>
          </>
        )}

        {/* Step 2: Create account */}
        {step === "create-account" && (
          <>
            <div className="text-center">
              <h1 className="text-2xl font-bold text-gray-900">
                Create your account
              </h1>
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">
                Set up your profile and upload your bills so you&apos;re ready to go when your invite comes through.
              </p>
            </div>

            {/* Google sign-up — always available, consent on click */}
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
              </div>
              <div>
                <label htmlFor="signup-dob" className="text-xs font-medium text-gray-600 mb-1 block">
                  Date of birth <span className="text-red-400">*</span>
                </label>
                <input
                  id="signup-dob"
                  type="date"
                  required
                  autoComplete="bday"
                  value={dateOfBirth}
                  max={new Date(new Date().setFullYear(new Date().getFullYear() - 18)).toISOString().split("T")[0]}
                  min="1920-01-01"
                  onChange={(e) => setDateOfBirth(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
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

              <button
                type="submit"
                disabled={accountLoading || !tosAccepted || !privacyAccepted || (password.length > 0 && passwordErrors.length > 0)}
                className="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-semibold"
              >
                {accountLoading ? "Creating account..." : "Create Account"}
              </button>
            </form>

            {accountError && <p className="text-red-600 text-sm text-center">{accountError}</p>}
          </>
        )}

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
    </div>
  );
}
