"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  applyActionCode,
  confirmPasswordReset,
  verifyPasswordResetCode,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/client";

// Multi-mode handler for Firebase email-action links. Configure Firebase Console
// → Authentication → Templates → "Customize action URL" to
// https://www.candidclaim.com/auth/action so that ALL action emails route here
// and skip the generic Firebase action page entirely.
//
// Modes handled:
//   verifyEmail     — applyActionCode(oobCode), show success
//   resetPassword   — verifyPasswordResetCode → form → confirmPasswordReset
//   verifyAndChangeEmail / signIn — not used by this app today; show error.

function ActionContent() {
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode");
  const oobCode = searchParams.get("oobCode");

  if (oobCode && mode === "resetPassword") {
    return <ResetPasswordMode oobCode={oobCode} />;
  }
  // verifyEmail (or post-redirect from Firebase action page with no oob params)
  return <VerifyEmailMode oobCode={mode === "verifyEmail" ? oobCode : null} />;
}

// ─── Verify email ──────────────────────────────────────────────────────────

function VerifyEmailMode({ oobCode }: { oobCode: string | null }) {
  type Status = "verifying" | "success" | "error";
  const initial: Status = oobCode ? "verifying" : "success";
  const [status, setStatus] = useState<Status>(initial);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (oobCode) {
      applyActionCode(getFirebaseAuth(), oobCode)
        .then(() => setStatus("success"))
        .catch((err: { code?: string }) => {
          const code = err?.code;
          if (code === "auth/expired-action-code") {
            setErrorMessage("This verification link has expired. Sign in and we'll send you a new one.");
          } else if (code === "auth/invalid-action-code") {
            setErrorMessage("This link is invalid or has already been used. Try signing in.");
          } else if (code === "auth/user-disabled") {
            setErrorMessage("Your account has been disabled. Contact support if you think this is a mistake.");
          } else {
            setErrorMessage("We couldn't verify your email. Try signing in — it may already be verified.");
          }
          setStatus("error");
        });
    }
  }, [oobCode]);

  return (
    <Shell>
      {status === "verifying" && (
        <div className="text-center space-y-4">
          <div className="mx-auto w-10 h-10 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <h1 className="text-xl font-semibold text-gray-900">Verifying your email…</h1>
          <p className="text-sm text-gray-500">This will just take a moment.</p>
        </div>
      )}

      {status === "success" && (
        <div className="space-y-5">
          <SuccessIcon />
          <Heading>Email verified</Heading>
          <p className="text-sm text-gray-500 leading-relaxed text-center">
            Your Candid account is confirmed. Sign in to finish setting up your profile and start auditing your bills.
          </p>
          <PrimaryLink href="/auth/signin?verified=true">Sign in to Candid</PrimaryLink>
        </div>
      )}

      {status === "error" && (
        <div className="space-y-5">
          <WarningIcon />
          <Heading>Verification problem</Heading>
          <p className="text-sm text-gray-500 leading-relaxed text-center">{errorMessage}</p>
          <PrimaryLink href="/auth/signin">Go to sign in</PrimaryLink>
        </div>
      )}
    </Shell>
  );
}

// ─── Reset password ────────────────────────────────────────────────────────

function validatePassword(pw: string): string[] {
  const errors: string[] = [];
  if (pw.length < 10) errors.push("At least 10 characters");
  if (!/[A-Z]/.test(pw)) errors.push("One uppercase letter");
  if (!/[a-z]/.test(pw)) errors.push("One lowercase letter");
  if (!/[0-9]/.test(pw)) errors.push("One number");
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push("One special character (!@#$%...)");
  return errors;
}

function ResetPasswordMode({ oobCode }: { oobCode: string }) {
  type Status = "verifying" | "form" | "submitting" | "success" | "error";
  const router = useRouter();
  const [status, setStatus] = useState<Status>("verifying");
  const [resetEmail, setResetEmail] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordErrors, setPasswordErrors] = useState<string[]>([]);

  useEffect(() => {
    verifyPasswordResetCode(getFirebaseAuth(), oobCode)
      .then((email) => {
        setResetEmail(email);
        setStatus("form");
      })
      .catch((err: { code?: string }) => {
        const code = err?.code;
        if (code === "auth/expired-action-code") {
          setErrorMessage("This password reset link has expired. Request a new one from the sign-in page.");
        } else if (code === "auth/invalid-action-code") {
          setErrorMessage("This link is invalid or has already been used. Request a new one from the sign-in page.");
        } else if (code === "auth/user-disabled") {
          setErrorMessage("Your account has been disabled. Contact support if you think this is a mistake.");
        } else {
          setErrorMessage("We couldn't validate this reset link. Please request a new one.");
        }
        setStatus("error");
      });
  }, [oobCode]);

  function handlePasswordChange(pw: string) {
    setPassword(pw);
    setPasswordErrors(pw.length > 0 ? validatePassword(pw) : []);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage("");
    if (password !== confirmPassword) {
      setErrorMessage("Passwords don't match.");
      return;
    }
    const pwErrors = validatePassword(password);
    if (pwErrors.length > 0) {
      setPasswordErrors(pwErrors);
      setErrorMessage("Please fix the password requirements below.");
      return;
    }
    setStatus("submitting");
    try {
      await confirmPasswordReset(getFirebaseAuth(), oobCode, password);
      setStatus("success");
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/weak-password") {
        setErrorMessage("Password is too weak. Try a longer or more complex one.");
      } else if (code === "auth/expired-action-code" || code === "auth/invalid-action-code") {
        setErrorMessage("This reset link is no longer valid. Please request a new one.");
      } else {
        setErrorMessage("Couldn't reset your password. Please try again.");
      }
      setStatus("form");
    }
  }

  return (
    <Shell>
      {status === "verifying" && (
        <div className="text-center space-y-4">
          <div className="mx-auto w-10 h-10 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <h1 className="text-xl font-semibold text-gray-900">Checking your link…</h1>
        </div>
      )}

      {(status === "form" || status === "submitting") && (
        <div className="space-y-5">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-900">Set a new password</h1>
            <p className="mt-2 text-sm text-gray-500">
              Resetting password for <span className="font-medium text-gray-700">{resetEmail}</span>.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="reset-password" className="text-xs font-medium text-gray-600 mb-1 block">
                New password <span className="text-red-400">*</span>
              </label>
              <input
                id="reset-password"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                placeholder="10+ characters"
                value={password}
                onChange={(e) => handlePasswordChange(e.target.value)}
                className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                  password.length > 0 && passwordErrors.length > 0 ? "border-red-300" : "border-gray-200"
                }`}
              />
            </div>

            {password.length > 0 && (
              <ul className="mt-1 space-y-1 text-xs">
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

            <div>
              <label htmlFor="reset-password-confirm" className="text-xs font-medium text-gray-600 mb-1 block">
                Confirm new password <span className="text-red-400">*</span>
              </label>
              <input
                id="reset-password-confirm"
                type="password"
                required
                autoComplete="new-password"
                placeholder="Re-enter password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <button
              type="submit"
              disabled={status === "submitting" || (password.length > 0 && passwordErrors.length > 0)}
              className="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-semibold"
            >
              {status === "submitting" ? "Saving…" : "Reset password"}
            </button>
          </form>

          {errorMessage && <p className="text-red-600 text-sm text-center">{errorMessage}</p>}
        </div>
      )}

      {status === "success" && (
        <div className="space-y-5">
          <SuccessIcon />
          <Heading>Password reset</Heading>
          <p className="text-sm text-gray-500 leading-relaxed text-center">
            Your Candid password has been updated. Sign in with your new password to continue.
          </p>
          <button
            onClick={() => router.push(`/auth/signin?email=${encodeURIComponent(resetEmail)}`)}
            className="block w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold text-center"
          >
            Sign in to Candid
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="space-y-5">
          <WarningIcon />
          <Heading>Reset link problem</Heading>
          <p className="text-sm text-gray-500 leading-relaxed text-center">{errorMessage}</p>
          <PrimaryLink href="/auth/signin">Go to sign in</PrimaryLink>
        </div>
      )}
    </Shell>
  );
}

// ─── Shared UI primitives ──────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4 bg-white">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link href="/" className="text-2xl font-bold text-blue-600">
            Candid
          </Link>
        </div>
        {children}
        <p className="text-xs text-gray-400 text-center">
          Candid is an Airgetlam Labs LLC company.
        </p>
      </div>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h1 className="text-2xl font-bold text-gray-900 text-center">{children}</h1>;
}

function SuccessIcon() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-14 h-14 rounded-full bg-green-50 border border-green-100 flex items-center justify-center">
        <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      </div>
    </div>
  );
}

function WarningIcon() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-14 h-14 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center">
        <svg className="w-7 h-7 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
      </div>
    </div>
  );
}

function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="block w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold text-center"
    >
      {children}
    </Link>
  );
}

// ─── Page wrapper ──────────────────────────────────────────────────────────

export default function ActionPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <ActionContent />
    </Suspense>
  );
}
