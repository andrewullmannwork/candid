"use client";

/**
 * Plan card for /profile Insurance section (S121 B2.1).
 *
 * Renders the user's matched plan summary with VerifyPill outline-green
 * "User Verified" badge per D-§1.B.2-F (NOT solid green per design literal —
 * Display State v4/v5 reserves solid green for canonical Pattern 1 #3 ≥3-user
 * promotion per [[Candid_Data_Patterns]] Pattern 1 #16). Renders inline rather
 * than via the <DisplayStateBadge> primitive because this card uses a non-
 * standard label ("User Verified" with state-derived semantics, not a raw
 * DisplayState union value).
 */

interface PlanCardProps {
  insurer: string;
  planName: string;
  planType: string;
  state: string;
  groupNumber: string;
}

export function PlanCard({
  insurer,
  planName,
  planType,
  state,
  groupNumber,
}: PlanCardProps) {
  const insurerBadge = (insurer || "Plan").split(/[\s/]/)[0] || "Plan";
  return (
    <div className="flex items-center gap-4 px-5 py-4 bg-gradient-to-br from-slate-50 to-white border border-gray-200 rounded-2xl">
      <div className="shrink-0 w-14 h-14 rounded-xl bg-blue-600 text-white grid place-items-center font-bold text-xs tracking-tight px-2 text-center leading-tight">
        {insurerBadge}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-bold text-gray-900 tracking-tight truncate">
          {planName || "Unknown plan"}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500 flex-wrap">
          {planType && <span>{planType}</span>}
          {planType && state && <span className="text-gray-300">•</span>}
          {state && <span>{state}</span>}
          {(planType || state) && groupNumber && (
            <span className="text-gray-300">•</span>
          )}
          {groupNumber && <span>Group {groupNumber}</span>}
        </div>
      </div>
      <span className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-green-500 bg-white text-green-700 text-[11px] font-semibold tracking-wide">
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 13l4 4L19 7" />
        </svg>
        User Verified
      </span>
    </div>
  );
}
