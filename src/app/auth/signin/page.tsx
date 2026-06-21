"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { TurnstileWidget } from "@/components/security/TurnstileWidget";

export default function SignInPage() {
  return (
    <Suspense>
      <SignInContent />
    </Suspense>
  );
}

function SignInContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signInWithEmail, signInWithGoogle } = useAuth();

  const existingAccount = searchParams.get("existing") === "true";
  const justVerified = searchParams.get("verified") === "true";
  const prefillEmail = searchParams.get("email") || "";

  const [email, setEmail] = useState(prefillEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!turnstileToken) {
      setError("Please check 'Verify you are human' above to continue.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await signInWithEmail(email, password, turnstileToken);
      router.push("/dashboard");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/user-not-found" || code === "auth/wrong-password" || code === "auth/invalid-credential") {
        setError("Invalid email or password.");
      } else if (code === "auth/too-many-requests") {
        setError("Too many failed attempts. Please try again later.");
      } else if (code === "auth/turnstile-failed") {
        setError("Bot defense check failed. Please reload the page and try again.");
      } else if (code === "auth/phone-verification-required") {
        // Firebase user exists but Supabase row doesn't — orphan from prior
        // abandoned signup. Route to /auth/signup which handles recovery.
        router.push("/auth/signup");
      } else {
        setError("Sign in failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    if (!email) {
      setError("Enter your email address first, then click Forgot password.");
      return;
    }
    if (!turnstileToken) {
      setError("Please check 'Verify you are human' above to continue.");
      return;
    }
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, turnstileToken }),
      });
      if (res.ok) {
        setResetSent(true);
        setError("");
      } else if (res.status === 403) {
        setError("Bot defense check failed. Please reload the page and try again.");
      } else {
        setError("Could not send reset email. Please check the address and try again.");
      }
    } catch {
      setError("Could not send reset email. Please check the address and try again.");
    }
  }

  async function handleGoogle() {
    if (!turnstileToken) {
      setError("Please check 'Verify you are human' above to continue.");
      return;
    }
    try {
      await signInWithGoogle(turnstileToken);
      router.push("/dashboard");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/turnstile-failed") {
        setError("Bot defense check failed. Please reload the page and try again.");
      } else if (code === "auth/phone-verification-required") {
        // Brand-new account attempted via /auth/signin — needs phone OTP. Route to signup.
        router.push("/auth/signup");
      } else {
        setError("Google sign-in failed");
      }
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link href="/" className="text-2xl font-bold text-blue-600">
            Candid
          </Link>
          <h1 className="mt-4 text-xl font-semibold">Sign in to your account</h1>
        </div>

        {existingAccount && (
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-center">
            <p className="text-sm text-blue-800 font-medium">
              It looks like you already have an account.
            </p>
            <p className="text-sm text-blue-700 mt-1">
              Sign in below to continue where you left off.
            </p>
          </div>
        )}

        {justVerified && !existingAccount && (
          <div className="p-4 bg-green-50 border border-green-200 rounded-lg flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-green-900">Email verified</p>
              <p className="text-sm text-green-700 mt-0.5">
                Sign in to finish setting up your Candid account.
              </p>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div>
            <input
              type="password"
              required
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={handleForgotPassword}
              className="mt-1.5 text-xs text-blue-600 hover:text-blue-700 font-medium"
            >
              Forgot password?
            </button>
          </div>

          {resetSent && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-sm text-green-700">Password reset email sent. Check your inbox.</p>
            </div>
          )}

          <TurnstileWidget action="signin" onToken={setTurnstileToken} />

          <button
            type="submit"
            disabled={loading || !turnstileToken}
            className="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {loading ? "Signing in..." : "Sign In"}
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
          className="w-full py-3 border rounded-lg hover:bg-gray-50 font-medium"
        >
          Continue with Google
        </button>

        {error && <p className="text-red-600 text-sm text-center">{error}</p>}

        <p className="text-center text-sm text-gray-500">
          Don&apos;t have an account?{" "}
          <Link href="/auth/signup" className="text-blue-600 hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
