"use client";

import Link from "next/link";

/**
 * MoreFromCandidCards — Case + Care "Coming soon" cards.
 *
 * Per D-§1.C.1-H: Claim is demoted OUT of "More from Candid" and promoted into
 * the dash-trio above. The "More from Candid" surface holds the two upcoming
 * products (Case + Care), both with `status="soon"` badges.
 *
 * NON-NEGOTIABLE per S112 §1.C.1 Critical Pass:
 *  - Case card MUST carry the CROA + marketplace-not-vetting disclaimer
 *    ("Candid does not provide legal advice or referrals…") per P5 Hard Rule
 *    #2 + Q-DR-1G1-3 LOCK + project_candid_marketplace_not_vetting memory.
 *  - Care card does NOT need a parallel disclaimer (AKS hard-rule preservation
 *    lives inside /care; the dashboard card is descriptive only).
 */
export function MoreFromCandidCards({ careContributedCount }: { careContributedCount?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <ProductCard
        href="/case"
        iconBg="bg-purple-50"
        iconInk="text-purple-700"
        icon={
          <path d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
        }
        name="Candid Case"
        statusLabel="Coming soon"
        desc="Build your case. Find your lawyer. Compile audits, dispute letters, and evidence into a downloadable case file."
        disclaimer="Candid does not provide legal advice or referrals. Attorney listings are for informational purposes only."
      />

      <ProductCard
        href="/care"
        iconBg="bg-cyan-50"
        iconInk="text-cyan-700"
        icon={
          <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        }
        name="Candid Care"
        statusLabel="Coming soon"
        desc="Compare what you paid against what others paid. Find fairer prices for procedures near you."
        contributedCount={careContributedCount}
      />
    </div>
  );
}

function ProductCard({
  href,
  iconBg,
  iconInk,
  icon,
  name,
  statusLabel,
  desc,
  disclaimer,
  contributedCount,
}: {
  href: string;
  iconBg: string;
  iconInk: string;
  icon: React.ReactNode;
  name: string;
  statusLabel: string;
  desc: string;
  disclaimer?: string;
  contributedCount?: number;
}) {
  return (
    <Link
      href={href}
      className="p-4 bg-gradient-to-br from-gray-50 to-white rounded-2xl ring-1 ring-gray-100 hover:ring-blue-200 transition-all group"
    >
      <div className="flex items-start gap-3 mb-2">
        <div className={`w-8 h-8 rounded-lg ${iconBg} ${iconInk} flex items-center justify-center shrink-0`}>
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {icon}
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
            {name}
          </h3>
          <span className="inline-block mt-0.5 text-[10px] font-semibold text-gray-600 bg-gray-100 ring-1 ring-inset ring-gray-200 px-1.5 py-0.5 rounded">
            {statusLabel}
          </span>
        </div>
      </div>
      <p className="text-xs text-gray-500 leading-relaxed">{desc}</p>
      {typeof contributedCount === "number" && contributedCount > 0 && (
        <div className="mt-2 flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500" aria-hidden="true" />
          <p className="text-[10px] font-medium text-green-700">
            {contributedCount} document{contributedCount !== 1 ? "s" : ""} contributed
          </p>
        </div>
      )}
      {disclaimer && (
        <p className="mt-2 text-[10px] text-gray-400 leading-relaxed">{disclaimer}</p>
      )}
    </Link>
  );
}
