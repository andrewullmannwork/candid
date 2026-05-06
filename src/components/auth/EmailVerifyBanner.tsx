"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

export function EmailVerifyBanner() {
  const { user } = useAuth();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  // Hide if no user, or email is verified, or banner already actioned for this session.
  if (!user || user.emailVerified) return null;

  async function handleResend() {
    if (!user) return;
    setSending(true);
    setError("");
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
      });
      if (res.ok) {
        setSent(true);
      } else {
        const body = await res.json().catch(() => ({}));
        setError(
          (body as { error?: string })?.error ??
            "Couldn't send the verification email. Please try again in a moment.",
        );
      }
    } catch {
      setError("Couldn't send the verification email. Please try again in a moment.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-start gap-3 flex-1">
        <svg className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-900">Please verify your email</p>
          {sent ? (
            <p className="text-sm text-amber-800">
              We just sent a fresh link to <span className="font-medium">{user.email}</span>. Check your inbox (and spam).
            </p>
          ) : (
            <p className="text-sm text-amber-800">
              Check your inbox for the link we sent to <span className="font-medium">{user.email}</span>. You can keep using
              Candid in the meantime — verifying your email gives your data more weight in our cross-user analysis.
            </p>
          )}
          {error && <p className="text-sm text-red-600 mt-1">{error}</p>}
        </div>
      </div>
      {!sent && (
        <button
          onClick={handleResend}
          disabled={sending}
          className="shrink-0 px-3 py-2 text-sm font-medium rounded-lg border border-amber-300 text-amber-900 hover:bg-amber-100 disabled:opacity-60"
        >
          {sending ? "Sending…" : "Resend email"}
        </button>
      )}
    </div>
  );
}
