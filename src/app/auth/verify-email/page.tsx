"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Backward-compat redirect for emails sent before /auth/action existed.
// Any oobCode + mode params are forwarded so /auth/action can complete the
// action without bouncing the user through Firebase's hosted page again.

function VerifyEmailRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams();
    const mode = searchParams.get("mode") || "verifyEmail";
    params.set("mode", mode);
    const oobCode = searchParams.get("oobCode");
    if (oobCode) params.set("oobCode", oobCode);
    router.replace(`/auth/action?${params.toString()}`);
  }, [router, searchParams]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
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
      <VerifyEmailRedirect />
    </Suspense>
  );
}
