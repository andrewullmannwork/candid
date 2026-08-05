"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useSearchParams } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase/client";
import { SmallClaimsPrep } from "@/components/legal/SmallClaimsPrep";
import { Disclaimer } from "@/components/shared/Disclaimer";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useMinHoldLoading } from "@/lib/loading/use-min-hold";

/**
 * /small-claims — Small claims court preparation page
 *
 * Feature-flagged by small_claims_prep.
 * NOT in nav sidebar — accessible only via escalation links.
 */
export default function SmallClaimsPage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const [flagEnabled, setFlagEnabled] = useState(false);
  const [flagLoading, setFlagLoading] = useState(true);
  const [userState, setUserState] = useState<string | null>(null);
  const [userCounty, setUserCounty] = useState<string | null>(null);

  const disputeAmount = parseFloat(searchParams.get("amount") || "0");
  const claimId = searchParams.get("claimId") || undefined;
  // S305 — the ?disputeId param is no longer read: the Case File this page
  // offers is the CLAIM's record. Links carrying it still work; it is ignored.

  useEffect(() => {
    const supabase = createBrowserClient();

    // Check feature flag
    supabase
      .from("feature_flag_rules")
      .select("enabled")
      .eq("flag_key", "small_claims_prep")
      .eq("target_type", "global")
      .single()
      .then(({ data }) => {
        setFlagEnabled(data?.enabled === true);
        setFlagLoading(false);
      }, () => setFlagLoading(false));

    // Get user state + county
    if (user) {
      fetch("/api/profile", {
        headers: { Authorization: `Bearer ${user.userId}` },
      })
        .then((r) => r.json())
        .then((d) => {
          setUserState(d.profile?.state || null);
          setUserCounty(d.profile?.county_name || null);
        })
        .catch(() => {});
    }
  }, [user]);

  const showCubeLoader = useMinHoldLoading(flagLoading);
  if (showCubeLoader) {
    return <CubeLoaderBuilding />;
  }

  if (!flagEnabled) {
    return (
      <div className="max-w-lg mx-auto mt-16 text-center">
        <p className="text-sm text-gray-500">Small claims preparation is not available yet.</p>
      </div>
    );
  }

  if (!userState) {
    return (
      <div className="max-w-lg mx-auto mt-8">
        <div className="p-6 bg-amber-50 border border-amber-200 rounded-xl text-center">
          <p className="text-sm font-semibold text-amber-900">State required</p>
          <p className="text-xs text-amber-700 mt-1">
            Update your profile with your state to see small claims court information.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Small Claims Court Preparation</h1>
        <p className="mt-1 text-sm text-gray-500">
          Check eligibility, find your court, and download your evidence package.
        </p>
      </div>

      <Disclaimer variant="small_claims" />

      <div className="mt-4">
        <SmallClaimsPrep
          state={userState}
          disputeAmount={disputeAmount || 500}
          county={userCounty || undefined}
          claimId={claimId}
        />
      </div>
    </div>
  );
}
