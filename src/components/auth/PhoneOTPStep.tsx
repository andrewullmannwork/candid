"use client";

import { useEffect, useRef, useState } from "react";
import type { ConfirmationResult } from "firebase/auth";

interface PhoneOTPStepProps {
  phoneE164: string;
  phoneDisplay: string;
  confirmationResult: ConfirmationResult;
  onVerified: () => void | Promise<void>;
  onResend: () => Promise<ConfirmationResult>;
}

const RESEND_COOLDOWN_SECONDS = 30;

export function PhoneOTPStep({
  phoneDisplay,
  confirmationResult: initialConfirmation,
  onVerified,
  onResend,
}: PhoneOTPStepProps) {
  const [code, setCode] = useState("");
  const [confirmation, setConfirmation] = useState(initialConfirmation);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resendCountdown, setResendCountdown] = useState(RESEND_COOLDOWN_SECONDS);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const t = setTimeout(() => setResendCountdown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCountdown]);

  function handleCodeChange(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    setError("");
  }

  async function handleVerify(e?: React.FormEvent) {
    e?.preventDefault();
    if (code.length !== 6) {
      setError("Enter the 6-digit code from your text message.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await confirmation.confirm(code);
      // confirm() links phone to firebaseUser; caller sync will pick up
      // decoded.phone_number on next /api/auth/sync request.
      await onVerified();
    } catch (err: unknown) {
      const fbErr = err as { code?: string };
      if (fbErr.code === "auth/invalid-verification-code") {
        setError("That code didn't match. Double-check and try again.");
      } else if (fbErr.code === "auth/code-expired") {
        setError("Your code expired. Tap Resend to get a new one.");
      } else if (fbErr.code === "auth/account-exists-with-different-credential") {
        setError(
          "This phone number is already linked to another Candid account. Please use a different number or sign in to that account.",
        );
      } else {
        setError("Verification failed. Please try again or tap Resend.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendCountdown > 0) return;
    setLoading(true);
    setError("");
    try {
      const newConfirmation = await onResend();
      setConfirmation(newConfirmation);
      setCode("");
      setResendCountdown(RESEND_COOLDOWN_SECONDS);
      inputRef.current?.focus();
    } catch {
      setError("Couldn't resend the code. Please try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleVerify} className="space-y-4">
      <div className="text-center space-y-1">
        <h2 className="text-lg font-semibold text-gray-900">Verify your phone</h2>
        <p className="text-sm text-gray-500">
          We sent a 6-digit code to <strong className="text-gray-700">{phoneDisplay}</strong>.
        </p>
      </div>

      <div>
        <label htmlFor="otp-code" className="sr-only">
          Verification code
        </label>
        <input
          ref={inputRef}
          id="otp-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(e) => handleCodeChange(e.target.value)}
          className="w-full px-4 py-3 text-center text-2xl tracking-[0.5em] font-mono border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      <button
        type="submit"
        disabled={loading || code.length !== 6}
        className="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-semibold"
      >
        {loading ? "Verifying…" : "Verify and finish signup"}
      </button>

      {error && <p className="text-red-600 text-sm text-center">{error}</p>}

      <div className="flex items-center justify-end text-sm">
        <button
          type="button"
          onClick={handleResend}
          disabled={resendCountdown > 0 || loading}
          className="text-blue-600 hover:text-blue-700 disabled:text-gray-400"
        >
          {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : "Resend code"}
        </button>
      </div>
    </form>
  );
}
