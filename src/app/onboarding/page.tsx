"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import { SIMPLIFIED_ONBOARDING_FLAG } from "@/lib/onboarding/simplified";

/**
 * /onboarding — the simplified 3-step flow (full-screen, no app sidebar, so
 * it lives OUTSIDE the (app) route group and carries its own auth gate).
 *
 * Flag-guarded: `onboarding_simplified_v1` OFF (or unreadable) bounces to the
 * legacy wizard URL with the signup prefill params carried, so a direct hit
 * on this route can never strand a user while the flag is off.
 */
export default function OnboardingPage() {
  return (
    <Suspense fallback={<CubeLoaderBuilding />}>
      <OnboardingGate />
    </Suspense>
  );
}

function OnboardingGate() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [flagOn, setFlagOn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/feature-flags/${SIMPLIFIED_ONBOARDING_FLAG}`)
      .then((r) => r.json())
      .then((j: { enabled?: boolean }) => {
        if (cancelled) return;
        if (j?.enabled === true) {
          setFlagOn(true);
        } else {
          setFlagOn(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFlagOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (flagOn !== false) return;
    // Flag OFF — hand over to the legacy wizard, params intact.
    const p = new URLSearchParams({ onboarding: "true" });
    const phone = searchParams.get("phone");
    const dob = searchParams.get("dob");
    if (phone) p.set("phone", phone);
    if (dob) p.set("dob", dob);
    router.replace(`/profile?${p.toString()}`);
  }, [flagOn, router, searchParams]);

  if (!loading && !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="space-y-4 text-center">
          <p className="text-gray-600">Please sign in to continue.</p>
          <Link
            href="/auth/signin"
            className="inline-block rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  if (loading || !user || flagOn !== true) {
    return <CubeLoaderBuilding />;
  }

  return <OnboardingFlow />;
}
