"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { Disclaimer } from "@/components/shared/Disclaimer";

interface CourtInfo {
  state: string;
  county: string | null;
  dollarLimitIndividual: number | null;
  filingFeeMin: number | null;
  filingFeeMax: number | null;
  statuteOfLimitationsYears: number | null;
  courtName: string | null;
  courtWebsite: string | null;
  formsUrl: string | null;
  attorneyAllowed: boolean;
  notes: string | null;
  lastVerified: string | null;
  isStale: boolean;
}

interface EligibilityResult {
  eligible: boolean;
  reason: string;
  courtInfo: CourtInfo | null;
}

export function SmallClaimsPrep({
  state,
  disputeAmount,
  county,
  claimId,
  disputeId,
}: {
  state: string;
  disputeAmount: number;
  county?: string;
  claimId?: string;
  disputeId?: string;
}) {
  const { user } = useAuth();
  const [result, setResult] = useState<EligibilityResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    async function check() {
      try {
        const params = new URLSearchParams({
          state,
          amount: disputeAmount.toString(),
        });
        if (county) params.set("county", county);

        const res = await fetch(`/api/legal/small-claims?${params}`);
        if (res.ok) setResult(await res.json());
      } catch {
        // Silent
      }
      setLoading(false);
    }
    check();
  }, [state, disputeAmount, county]);

  if (loading) return <div className="text-sm text-gray-500">Checking eligibility...</div>;
  if (!result) return null;

  const court = result.courtInfo;

  return (
    <div>
      <Disclaimer variant="small_claims" />

      {/* Eligibility badge */}
      <div className={`mt-4 p-4 rounded-xl border ${
        result.eligible ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"
      }`}>
        <p className={`text-sm font-semibold ${result.eligible ? "text-green-900" : "text-amber-900"}`}>
          {result.eligible ? "Eligible for small claims court" : "May not be eligible"}
        </p>
        <p className={`text-xs mt-1 ${result.eligible ? "text-green-700" : "text-amber-700"}`}>
          {result.reason}
        </p>
      </div>

      {/* Court info */}
      {court && (
        <div className="mt-4 bg-white border border-gray-100 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">
            {court.courtName || `${court.state} Small Claims Court`}
          </h3>

          {court.isStale && (
            <div className="mb-3 p-2 bg-amber-50 border border-amber-100 rounded-lg">
              <p className="text-[10px] text-amber-700">
                This court data was last verified {court.lastVerified || "more than 6 months ago"}.
                Please verify directly with the court before filing.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-xs">
            {court.dollarLimitIndividual != null && (
              <div>
                <p className="text-gray-500">Dollar Limit</p>
                <p className="font-semibold text-gray-900">${court.dollarLimitIndividual.toLocaleString()}</p>
              </div>
            )}
            {(court.filingFeeMin != null || court.filingFeeMax != null) && (
              <div>
                <p className="text-gray-500">Filing Fee</p>
                <p className="font-semibold text-gray-900">
                  ${court.filingFeeMin || 0}–${court.filingFeeMax || "varies"}
                </p>
              </div>
            )}
            {court.statuteOfLimitationsYears != null && (
              <div>
                <p className="text-gray-500">Statute of Limitations</p>
                <p className="font-semibold text-gray-900">{court.statuteOfLimitationsYears} years</p>
              </div>
            )}
            <div>
              <p className="text-gray-500">Attorney Allowed?</p>
              <p className="font-semibold text-gray-900">{court.attorneyAllowed ? "Yes" : "No"}</p>
            </div>
          </div>

          {court.courtWebsite && (
            <a
              href={court.courtWebsite}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-3 text-xs text-blue-600 hover:text-blue-700"
            >
              Court website &rarr;
            </a>
          )}
          {court.formsUrl && (
            <a
              href={court.formsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-1 ml-4 text-xs text-blue-600 hover:text-blue-700"
            >
              Filing forms &rarr;
            </a>
          )}

          {court.notes && (
            <p className="mt-3 text-xs text-gray-500 italic">{court.notes}</p>
          )}
        </div>
      )}

      {/* Evidence package download — gated by SubscriptionGate in Phase 5A */}
      {claimId && (
        <div className="mt-4">
          <button
            onClick={async () => {
              if (!user || downloading) return;
              setDownloading(true);
              try {
                const token = await user.firebaseUser.getIdToken();
                const res = await fetch(`/api/legal/evidence-package?claimId=${claimId}${disputeId ? `&disputeId=${disputeId}` : ""}`, {
                  headers: { Authorization: `Bearer ${token}` },
                });
                if (res.ok) {
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `evidence-package-${claimId.slice(0, 8)}.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                }
              } catch {
                // Silent
              }
              setDownloading(false);
            }}
            disabled={downloading}
            className="w-full py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {downloading ? "Compiling..." : "Download evidence package"}
          </button>
        </div>
      )}

      <Disclaimer variant="small_claims" className="mt-3" />
    </div>
  );
}
