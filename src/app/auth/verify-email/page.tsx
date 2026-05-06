"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { applyActionCode } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/client";

type Status = "verifying" | "success" | "error";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const oobCode = searchParams.get("oobCode");
  const mode = searchParams.get("mode");

  // If the link came directly from a configured Firebase action URL, oobCode +
  // mode will be present and we apply the code ourselves. If the link routed
  // through the default Firebase action handler first (continueUrl pattern),
  // those params won't be set and we just show the success card — Firebase has
  // already verified the email by the time the user lands here.
  const initial: Status = oobCode && mode === "verifyEmail" ? "verifying" : "success";
  const [status, setStatus] = useState<Status>(initial);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (oobCode && mode === "verifyEmail") {
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
  }, [oobCode, mode]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4 bg-white">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link href="/" className="text-2xl font-bold text-blue-600">
            Candid
          </Link>
        </div>

        {status === "verifying" && (
          <div className="text-center space-y-4">
            <div className="mx-auto w-10 h-10 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <h1 className="text-xl font-semibold text-gray-900">Verifying your email…</h1>
            <p className="text-sm text-gray-500">This will just take a moment.</p>
          </div>
        )}

        {status === "success" && (
          <div className="space-y-5">
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="w-14 h-14 rounded-full bg-green-50 border border-green-100 flex items-center justify-center">
                <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-gray-900">Email verified</h1>
              <p className="text-sm text-gray-500 leading-relaxed">
                Your Candid account is confirmed. Sign in to finish setting up your profile and start auditing your bills.
              </p>
            </div>

            <Link
              href="/auth/signin?verified=true"
              className="block w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold text-center"
            >
              Sign in to Candid
            </Link>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-5">
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="w-14 h-14 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center">
                <svg className="w-7 h-7 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-gray-900">Verification problem</h1>
              <p className="text-sm text-gray-500 leading-relaxed">{errorMessage}</p>
            </div>

            <Link
              href="/auth/signin"
              className="block w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold text-center"
            >
              Go to sign in
            </Link>
          </div>
        )}

        <p className="text-xs text-gray-400 text-center">
          Candid is an Airgetlam Labs LLC company.
        </p>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
