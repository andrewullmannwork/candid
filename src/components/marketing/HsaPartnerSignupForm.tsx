"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * Phone-only partner sign-up form embedded inside the /hsa-marketplace
 * coming-soon overlay (B-LAND.1 / S130). Soft validation: 10+ digit minimum
 * with `+ ( ) - . space` separators allowed; downstream support team
 * triages bad numbers.
 *
 * On submit, POSTs to /api/support (auth-gated; partner must be signed in)
 * with category="other" and a marker subject so the inbox is greppable
 * by "HSA Partner Sign-Up". When B3-HSA marketplace ships post-alpha + OPS.8
 * counsel review clears, this stays in place to keep partner onboarding open.
 */
export function HsaPartnerSignupForm() {
  const { user } = useAuth();
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digitCount = phone.replace(/\D/g, "").length;
  const canSubmit = digitCount >= 10 && !submitting && !!user;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !user) return;

    setSubmitting(true);
    setError(null);

    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/support", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          category: "other",
          subject: "HSA Partner Sign-Up — Sales Lead",
          body: `Partner phone: ${phone.trim()}\nSubmitted from: /hsa-marketplace coming-soon overlay\nUser account: ${user.email}`,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Submission failed — please try again.");
      }

      setSubmitted(true);
      setPhone("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="text-center py-2">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700">
          <span className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center">
            <svg width={11} height={11} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M5 13l4 4L19 7" />
            </svg>
          </span>
          Got it. Expect a call within 2–3 business days.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-bold text-gray-900">
        Are you an HSA-eligible product or service?
      </h3>
      <p className="mt-1 text-[12.5px] text-gray-500 leading-relaxed">
        We&apos;re onboarding launch partners. Get in front of users actively spending
        HSA/FSA dollars.
      </p>

      <form onSubmit={handleSubmit} className="mt-3 flex flex-col sm:flex-row gap-2">
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="Your phone number"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={submitting}
          className="flex-1 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-400/30 focus:border-rose-300 disabled:bg-gray-50 disabled:text-gray-400"
        />
        <button
          type="submit"
          disabled={!canSubmit}
          className="px-5 py-2 text-white font-semibold text-sm rounded-xl bg-rose-400 hover:bg-rose-500 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {submitting ? "Sending…" : "Get a call"}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-[12px] text-red-600">{error}</p>
      )}
    </div>
  );
}
