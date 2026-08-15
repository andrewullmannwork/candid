"use client";

/**
 * /check — the no-account bill check (S315; flag `anonymous_bill_check_v1`).
 *
 * A-1 STUB: carries the route, the flag gate, and the audience guards so the
 * (app) layout's anonymous redirect has a real destination. A-2 replaces the
 * placeholder body with the approved Screen-1 composition (DropZoneStates +
 * HealthConsentModal variant + Turnstile → startAnonymousCheck). Design record:
 * vault plans/s315-anonymous-funnel-design.md; mock rev 4 approved 2026-08-15.
 *
 * Audience guards (design §7.6 "States + guards"):
 *   full account   → /upload (one upload surface per audience — no data fork)
 *   flag OFF       → / (the route does not exist as product yet)
 *   anonymous/new  → the check flow
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useFeatureFlag } from "@/lib/config/use-feature-flag";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";

export default function CheckPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { enabled, loading: flagLoading } = useFeatureFlag("anonymous_bill_check_v1");

  const settled = !authLoading && !flagLoading;
  const isFullAccount = !!user && !user.isAnonymous;

  useEffect(() => {
    if (!settled) return;
    if (!enabled) {
      router.replace("/");
    } else if (isFullAccount) {
      router.replace("/upload");
    }
  }, [settled, enabled, isFullAccount, router]);

  if (!settled || !enabled || isFullAccount) {
    return <CubeLoaderBuilding className="min-h-screen" />;
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md text-center space-y-3">
        <p className="text-lg font-semibold text-gray-900">
          The free bill check is almost ready.
        </p>
        <p className="text-sm text-gray-500">
          {/* A-2 replaces this stub with the approved consent + upload screen. */}
          Check back soon.
        </p>
      </div>
    </main>
  );
}
