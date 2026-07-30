"use client";

import { useState } from "react";

/**
 * Cost Structure grid for /profile dashboard (S121 B2.1).
 *
 * 8 in-network tiles + collapsible "Out-of-network details" accordion per
 * D-§1.B.2-E. The OON accordion preserves CF-55 visibility (Session 108 added
 * OON to per-service cite-grade candidates for dispute-letter evidence)
 * without cluttering the dashboard hero.
 */

interface CostStatProps {
  label: string;
  value: string;
  prefix?: string;
  suffix?: string;
  sub?: string;
  /** `is_met` variant — green tint when the in-network deductible reads $0. */
  met?: boolean;
}

interface CostStructureGridProps {
  inNetwork: {
    deductibleIndividual: string;
    deductibleFamily: string;
    oopMaxIndividual: string;
    oopMaxFamily: string;
    copayPrimary: string;
    copaySpecialist: string;
    copayER: string;
    /** S294 — shown on the ER tile when the plan has no ER copay (coinsurance-based ER). */
    coinsuranceER?: string;
    coinsurancePct: string;
  };
  outOfNetwork: {
    deductibleIndividual: string;
    deductibleFamily: string;
    oopMaxIndividual: string;
    oopMaxFamily: string;
  };
}

function StatTile({
  label,
  value,
  prefix = "",
  suffix = "",
  sub,
  met,
}: CostStatProps) {
  const isEmpty = !value || value.trim() === "";
  return (
    <div
      className={`px-4 py-3 rounded-2xl border ${
        met ? "bg-green-50 border-green-200" : "bg-white border-gray-200"
      }`}
    >
      <div className="text-[11px] font-medium text-gray-500 leading-tight">
        {label}
      </div>
      <div
        className={`mt-1 text-lg font-bold tracking-tight ${
          met
            ? "text-green-700"
            : isEmpty
              ? "text-gray-300"
              : "text-gray-900"
        }`}
      >
        {isEmpty ? "—" : `${prefix}${value}${suffix}`}
      </div>
      {sub && (
        <div
          className={`mt-0.5 text-[10px] font-medium ${
            met ? "text-green-600" : "text-gray-400"
          }`}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

export function CostStructureGrid({
  inNetwork,
  outOfNetwork,
}: CostStructureGridProps) {
  const [oonOpen, setOonOpen] = useState(false);
  // is_met variant: deductible reads "0" AND the field is populated (distinguishes
  // "$0 met" from "unknown / not populated yet").
  const deductibleIndMet =
    !!inNetwork.deductibleIndividual &&
    inNetwork.deductibleIndividual.trim() === "0";

  const hasOON =
    !!outOfNetwork.deductibleIndividual ||
    !!outOfNetwork.deductibleFamily ||
    !!outOfNetwork.oopMaxIndividual ||
    !!outOfNetwork.oopMaxFamily;

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatTile
          label="Deductible (in-network)"
          value={inNetwork.deductibleIndividual}
          prefix="$"
          sub={deductibleIndMet ? "Met for the year" : "Individual"}
          met={deductibleIndMet}
        />
        <StatTile
          label="Deductible (family)"
          value={inNetwork.deductibleFamily}
          prefix="$"
          sub="Of family plan"
        />
        <StatTile
          label="OOP max (in-network)"
          value={inNetwork.oopMaxIndividual}
          prefix="$"
          sub="Individual"
        />
        <StatTile
          label="OOP max (family)"
          value={inNetwork.oopMaxFamily}
          prefix="$"
          sub="Family"
        />
        <StatTile label="PCP copay" value={inNetwork.copayPrimary} prefix="$" />
        <StatTile
          label="Specialist"
          value={inNetwork.copaySpecialist}
          prefix="$"
        />
        {/* S294 — coinsurance-based ER (no copay exists): show the percent under
            an honest label instead of a dash. Copay wins when both exist. */}
        {!inNetwork.copayER?.trim() && inNetwork.coinsuranceER?.trim() ? (
          <StatTile label="ER coinsurance" value={inNetwork.coinsuranceER} suffix="%" />
        ) : (
          <StatTile label="ER copay" value={inNetwork.copayER} prefix="$" />
        )}
        <StatTile
          label="Coinsurance"
          value={inNetwork.coinsurancePct}
          suffix="%"
        />
      </div>

      {hasOON && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <button
            type="button"
            onClick={() => setOonOpen((v) => !v)}
            aria-expanded={oonOpen}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-gray-900 transition-colors"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${
                oonOpen ? "rotate-90" : ""
              }`}
              aria-hidden="true"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
            Out-of-network details
          </button>
          {oonOpen && (
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <StatTile
                label="Deductible (OON)"
                value={outOfNetwork.deductibleIndividual}
                prefix="$"
                sub="Individual"
              />
              <StatTile
                label="Deductible (OON family)"
                value={outOfNetwork.deductibleFamily}
                prefix="$"
                sub="Family"
              />
              <StatTile
                label="OOP max (OON)"
                value={outOfNetwork.oopMaxIndividual}
                prefix="$"
                sub="Individual"
              />
              <StatTile
                label="OOP max (OON family)"
                value={outOfNetwork.oopMaxFamily}
                prefix="$"
                sub="Family"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
