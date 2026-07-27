"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * BenefitsGrid — 12-tile 2-col category overview on /dashboard.
 *
 * Replaces the prior catMap-derived 2-col rendering with the design's compact
 * category grid. Tiles are NAVIGATION-ONLY (click → /plan#{categoryId}) per
 * D-§1.C.1-F — benefit check-off interactivity lives on /plan.
 *
 * Per D-§1.C.1-E:
 *  - Tile names + sub-labels MUST be AMA-clean (sourced from candid's
 *    BENEFIT_CATEGORY_LABELS / SERVICE_CATEGORY_LABELS or Benefit.title); never
 *    use design's AMA-licensable literals ("Advanced Imaging (CT/PET/MRI)" etc.)
 *  - Benefits that don't map to one of the 12 design domains → "Other" 13th tile
 *  - Empty tiles (count=0) → grey-out variant; visual coherence preserved when
 *    plan data is sparse
 *
 * DOMAIN_STYLES + ICONLIB constants live here (single source of truth for tile
 * visual treatment); category-to-domain mapping lives in dashboard/page.tsx
 * since it's dashboard-specific (B3.2 /plan uses its own accordion rendering).
 */

export type TileDomain =
  | "imaging"
  | "emergency"
  | "office"
  | "preventive"
  | "hospital"
  | "ltc"
  | "lab"
  | "therapy"
  | "maternity"
  | "rx"
  | "mental"
  | "equip"
  | "other";

export interface BenefitsGridTile {
  /** Internal id (tile slot — "imaging", "hospital", etc.). Stable + design-aligned. */
  id: string;
  /** Tile name shown big. AMA-clean ("Imaging", "Mental Health"). */
  name: string;
  /** Sub-label shown small under name. AMA-clean (top benefit title or candid category label). */
  sub?: string;
  /** Total benefits in this tile. */
  count: number;
  /** Checked-off count (from localStorage usedBenefits set; navigation-only on /dashboard). */
  usedCount: number;
  /** Visual treatment domain. */
  domain: TileDomain;
  /**
   * Candid category string (BenefitCategory enum value OR service_catalog key)
   * of the dominant benefit in this tile. Used to build the /plan deep-link
   * (`/plan?cat={categoryKey}` — S289: a QUERY param, not a hash: the App
   * Router caches /plan's client tree across soft navs, so mount-time hash
   * reads never re-run on a tile click; useSearchParams is the reactive
   * channel that opens + scrolls the target accordion every time). Falls back
   * to plain /plan when undefined (e.g., empty tile with count=0).
   */
  categoryKey?: string;
}

const DOMAIN_STYLES: Record<TileDomain, { bg: string; ink: string }> = {
  imaging: { bg: "bg-violet-100", ink: "text-violet-700" },
  emergency: { bg: "bg-red-50", ink: "text-red-700" },
  office: { bg: "bg-blue-50", ink: "text-blue-700" },
  preventive: { bg: "bg-blue-50", ink: "text-blue-700" },
  hospital: { bg: "bg-violet-50", ink: "text-violet-800" },
  ltc: { bg: "bg-fuchsia-50", ink: "text-fuchsia-700" },
  lab: { bg: "bg-cyan-50", ink: "text-cyan-700" },
  therapy: { bg: "bg-orange-50", ink: "text-orange-700" },
  maternity: { bg: "bg-pink-50", ink: "text-pink-700" },
  rx: { bg: "bg-green-50", ink: "text-green-700" },
  mental: { bg: "bg-purple-100", ink: "text-purple-700" },
  equip: { bg: "bg-emerald-50", ink: "text-emerald-700" },
  other: { bg: "bg-gray-50", ink: "text-gray-600" },
};

const ICONLIB: Record<TileDomain, string> = {
  imaging:
    "M3 5a2 2 0 012-2h2l1.5 2H14l1.5-2h2a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V5zM10 14a3 3 0 11-1-5.83",
  emergency:
    "M12 9v3m0 3v.01M5.07 19h13.86a2 2 0 001.74-2.99l-6.93-12a2 2 0 00-3.48 0l-6.93 12A2 2 0 005.07 19z",
  office:
    "M6 4v6a4 4 0 008 0V4M8 4h0M12 4h0M10 14v3a5 5 0 0010 0v-3a3 3 0 10-3-3M17 11a1 1 0 100-2 1 1 0 000 2z",
  preventive:
    "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  hospital:
    "M3 21h18M5 21V7a2 2 0 012-2h10a2 2 0 012 2v14M9 9h.01M13 9h.01M9 13h.01M13 13h.01M9 17h.01M13 17h.01",
  ltc:
    "M2 17v-7a2 2 0 012-2h4v-2a1 1 0 011-1h6a1 1 0 011 1v2h4a2 2 0 012 2v7M2 17v3M22 17v3M2 17h20M6 13a2 2 0 110-4 2 2 0 010 4z",
  lab:
    "M9 3h6M10 3v6L4 19a2 2 0 002 2h12a2 2 0 002-2l-6-10V3M8 14h8",
  therapy: "M3 17l6-6 4 4 7-7M14 7h5v5",
  maternity: "M12 7a5 5 0 11-5 5M12 7v10M12 17l-2.5 2.5M12 17l2.5 2.5",
  rx: "M10.5 20.5a7 7 0 01-9-9l9-9a7 7 0 019 9l-9 9zM6 6l12 12",
  mental:
    "M9 4a4 4 0 00-4 4v.5a3 3 0 000 6V16a4 4 0 008 0V8a4 4 0 00-4-4zM15 4a4 4 0 014 4v.5a3 3 0 010 6V16a4 4 0 01-8 0",
  equip: "M13 10V3L4 14h7v7l9-11h-7z",
  other: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5l5 5v11a2 2 0 01-2 2z",
};

function TileIcon({ domain }: { domain: TileDomain }): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICONLIB[domain]} />
    </svg>
  );
}

export function BenefitsGrid({ tiles }: { tiles: BenefitsGridTile[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {tiles.map((t) => {
        const s = DOMAIN_STYLES[t.domain];
        const isEmpty = t.count === 0;
        const pct = t.count > 0 ? Math.round((t.usedCount / t.count) * 100) : 0;
        return (
          <Link
            key={t.id}
            href={t.categoryKey ? `/plan?cat=${encodeURIComponent(t.categoryKey)}` : "/plan"}
            className={cn(
              "block p-3.5 rounded-xl bg-white ring-1 ring-gray-100 transition-all group",
              "hover:ring-blue-200 hover:bg-blue-50/30",
              isEmpty && "opacity-60",
            )}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn("w-9 h-9 rounded-lg flex items-center justify-center shrink-0", s.bg, s.ink)}
                aria-hidden="true"
              >
                <TileIcon domain={t.domain} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-semibold text-gray-900 truncate group-hover:text-blue-700 transition-colors">
                  {t.name}
                </div>
                {t.sub && <div className="text-[11.5px] text-gray-400 truncate mt-0.5">{t.sub}</div>}
              </div>
              {/* S289 — count only (was `used/count`): the "0/1" fraction read
                  as "you have zero benefits", not "none checked off yet". The
                  progress bar below stays as the used-progress signal. */}
              <div
                className={cn(
                  "text-[10px] font-bold shrink-0",
                  t.count > 0 && t.usedCount === t.count ? "text-green-600" : "text-gray-400",
                )}
              >
                {t.count}
              </div>
            </div>
            <div className="mt-2.5 h-1 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </Link>
        );
      })}
    </div>
  );
}
