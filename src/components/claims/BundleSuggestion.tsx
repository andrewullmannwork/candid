"use client";

/**
 * BundleSuggestion — bottom-of-bill-detail card listing peer bills from the
 * same visit group (claim_group_id). Replaces the S?? "Related documents (N)"
 * sidebar banner with the design's bottom-card treatment.
 *
 * Design source-of-truth: design's `BundleSuggestion` in bill-detail (2).jsx.
 *
 * S139 Q2 defer: NO "See the bundle" / bundle CTA. Peer tiles link to each
 * bill's individual detail view. Bundle pipeline + screen are post-launch.
 *
 * S139 A.1: consumes provider_name lifted from claim metadata.provider.name
 * via /api/claims/[claimId] relatedClaims SELECT (added in same commit).
 */

import { plainDateShort } from "@/lib/format/dates";

interface PeerBill {
  id: string;
  date_of_service: string;
  status: string;
  total_billed: number;
  provider_name: string | null;
}

function fmt$(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function BundleSuggestion({
  peers,
  onSelectBill,
}: {
  peers: PeerBill[];
  onSelectBill: (id: string) => void;
}) {
  if (peers.length === 0) return null;

  return (
    <div className="mt-7">
      <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.08em] text-gray-500">
        Related to this visit
      </div>
      <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50/50 to-white p-5">
        <div className="mb-3 text-sm font-semibold text-gray-900">
          {peers.length} other bill{peers.length === 1 ? "" : "s"} from this visit
        </div>
        <div className="mb-1 text-[12.5px] text-gray-600">
          Each one is audited individually. Open any to review its breakdown.
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {peers.map((peer) => (
            <button
              key={peer.id}
              type="button"
              onClick={() => onSelectBill(peer.id)}
              className="flex w-full items-center gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/30"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold text-gray-900">
                  {peer.provider_name ?? "Provider details unavailable"}
                </div>
                <div className="mt-0.5 truncate text-[12px] text-gray-500">
                  {/* S311 — DoS is a DATE-ONLY value (F13's rule): the local-
                      timezone parse this replaced rendered Apr 25 as "Apr 24". */}
                  {peer.date_of_service ? plainDateShort(peer.date_of_service) : "Date unknown"}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[13px] font-bold tabular-nums text-gray-900">
                  ${fmt$(peer.total_billed)}
                </div>
                <div className="text-[11px] text-gray-500">billed</div>
              </div>
              <svg className="h-4 w-4 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
