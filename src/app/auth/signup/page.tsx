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
  const [tosAccepted, setTosAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountLoading, setAccountLoading] = useState(false);

  const [passwordErrors, setPasswordErrors] = useState<string[]>([]);

  const tosDoc = getConsentDocument("tos");
  const privacyDoc = getConsentDocument("privacy_policy");

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
      await signUpWithEmail(email, password, consents);

      // Send to profile with flag to continue to upload
      router.push("/profile?onboarding=true");
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

  async function handleGoogle() {
    if (!tosAccepted || !privacyAccepted) {
      setAccountError("You must accept both the Terms of Service and Privacy Policy.");
      return;
    }
    try {
      const consents = [
        { type: "tos", version: tosDoc.version, hash: tosDoc.hash },
        { type: "privacy_policy", version: privacyDoc.version, hash: privacyDoc.hash },
      ];
      await signInWithGoogle(consents);
      router.push("/profile?onboarding=true");
    } catch {
      setAccountError("Google sign-up failed");
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

            <form onSubmit={handleCreateAccount} className="space-y-4">
              <input
                type="email"
                required
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <input
                type="password"
                required
                minLength={10}
                placeholder="Password (10+ characters)"
                value={password}
                onChange={(e) => handlePasswordChange(e.target.value)}
                className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                  password.length > 0 && passwordErrors.length > 0
                    ? "border-red-300"
                    : "border-gray-200"
                }`}
              />
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

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white text-gray-500">or</span>
              </div>
            </div>

            <button
              onClick={handleGoogle}
              disabled={!tosAccepted || !privacyAccepted}
              className="w-full py-3 border rounded-lg hover:bg-gray-50 disabled:opacity-50 font-medium"
            >
              Continue with Google
            </button>

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
          You must be 18 or older to use Candid.
        </p>
      </div>
    </div>
  );
}
