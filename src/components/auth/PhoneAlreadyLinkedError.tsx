"use client";

import Link from "next/link";

const PHONE_ALREADY_LINKED_MARKER = "already linked to another Candid account";

interface AuthErrorMessageProps {
  error: string;
  className?: string;
}

/**
 * CF-33 (Session 72) — renders auth flow error messages and, when the error
 * is the phone-already-linked variant, appends a "Sign in to that account"
 * hyperlink so the user has a one-click escape route instead of a UX dead-end.
 *
 * Detection is text-based (matches "already linked to another Candid account")
 * because the error reaches the render layer as a plain string set via
 * `setError(...)` from 3 sites: PhoneOTPStep onConfirm catch, signup page
 * email-account-creation catch, and signup page Google phone-prompt catch.
 * String-match keeps the change additive without restructuring error state.
 */
export function AuthErrorMessage({ error, className }: AuthErrorMessageProps) {
  if (!error) return null;
  const isPhoneAlreadyLinked = error.includes(PHONE_ALREADY_LINKED_MARKER);
  const baseClass = className ?? "text-red-600 text-sm text-center";
  return (
    <p className={baseClass}>
      {error}
      {isPhoneAlreadyLinked && (
        <>
          {" "}
          <Link
            href="/auth/signin"
            className="text-blue-600 hover:text-blue-700 underline font-semibold"
          >
            Sign in to that account
          </Link>
          .
        </>
      )}
    </p>
  );
}
