"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * DataSourceContextLine — explicit methodology disclosure per Pattern 1 #11.
 *
 * Renders between section header and benefits content on /dashboard (B3.1) and
 * /plan (B3.2) — wherever a benefits surface needs to disclose the data source
 * tier. Extracted from S119 dashboard.tsx:570-636 + /plan equivalent into a
 * reusable primitive per S112 §1.C.1 Rec 9.
 *
 * Tier (per S112 §1.C.1 Rec 9 + Pattern 1 #11):
 *  - GREEN  (verified)   — user_plan + sbc_upload/plan_doc_upload, or vs != "unverified", or matched_plan, or cms_api
 *  - AMBER  (unverified) — user_plan + insurance_card/manual, or verified_plan, or static_catalog with planType
 *  - GREY   (unknown)    — static_catalog with no planType
 *
 * 7 copy variants preserved byte-identical from prior inline implementation to
 * avoid methodology-disclosure regressions across surfaces.
 */

type Tier = "verified" | "unverified" | "unknown";

interface DataSourceContextLineProps {
  /** planResult.dataSource — e.g., "user_plan", "user_plan_with_canonical", "matched_plan", "cms_api", "verified_plan", "static_catalog". */
  dataSource?: string;
  /** planResult.planSource — e.g., "sbc_upload", "plan_doc_upload", "manual", "insurance_card", "catalog_match". */
  planSource?: string;
  /** planResult.planType — e.g., "PPO", "HMO", "EPO". Affects static_catalog copy. */
  planType?: string;
  /** planResult.planSummary?.verificationStatus — e.g., "verified", "unverified". */
  verificationStatus?: string;
  className?: string;
}

interface DerivedCopy {
  tier: Tier;
  body: ReactNode;
}

function derive(props: DataSourceContextLineProps): DerivedCopy | null {
  const { dataSource: ds, planSource: ps, planType: pt, verificationStatus: vs } = props;

  // Variants 1-3: user-uploaded plan profile (with or without canonical link).
  if (ds === "user_plan" || ds === "user_plan_with_canonical") {
    if (ps === "sbc_upload" || ps === "plan_doc_upload" || (vs && vs !== "unverified")) {
      return { tier: "verified", body: <>Results based on your uploaded document.</> };
    }
    if (ps === "manual") {
      return {
        tier: "unverified",
        body: (
          <>
            Showing common benefits for your plan type &mdash; this isn&rsquo;t representative of
            your specific coverage.{" "}
            <Link href="/upload" className="font-semibold underline">
              Upload your plan document
            </Link>{" "}
            for accurate, complete results.
          </>
        ),
      };
    }
    // insurance_card or unspecified planSource
    return {
      tier: "unverified",
      body: (
        <>
          Showing common benefits for your plan type &mdash; your insurance card alone doesn&rsquo;t
          reveal your specific coverage.{" "}
          <Link href="/upload" className="font-semibold underline">
            Upload your plan document
          </Link>{" "}
          for accurate, complete results.
        </>
      ),
    };
  }

  // Variant 4: card → exact catalog match.
  if (ds === "matched_plan" || ds === "cms_api") {
    return {
      tier: "verified",
      body: <>Results based on a Candid verified plan matching your insurance card.</>,
    };
  }

  // Variant 5: similar plan match.
  if (ds === "verified_plan") {
    return {
      tier: "unverified",
      body: (
        <>
          Results based on a plan similar to yours.{" "}
          <Link href="/upload" className="font-semibold underline">
            Upload your plan document
          </Link>{" "}
          for more complete results.
        </>
      ),
    };
  }

  // Variants 6-7: static_catalog fallback.
  if (ds === "static_catalog") {
    if (pt) {
      return {
        tier: "unverified",
        body: (
          <>
            Results based on your {pt} plan type.{" "}
            <Link href="/upload" className="font-semibold underline">
              Upload your plan document
            </Link>{" "}
            for more complete results.
          </>
        ),
      };
    }
    return {
      tier: "unknown",
      body: (
        <>
          No insurance information on file. Results based on the typical user.{" "}
          <Link href="/profile" className="font-semibold underline">
            Upload your insurance card
          </Link>{" "}
          and{" "}
          <Link href="/upload" className="font-semibold underline">
            plan document
          </Link>{" "}
          for more complete results.
        </>
      ),
    };
  }

  return null;
}

const TIER_STYLES: Record<Tier, { icon: ReactNode; iconColor: string; textColor: string }> = {
  verified: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 13l4 4L19 7" />
      </svg>
    ),
    iconColor: "text-green-600",
    textColor: "text-green-700",
  },
  unverified: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    ),
    iconColor: "text-amber-600",
    textColor: "text-amber-700",
  },
  unknown: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01" />
      </svg>
    ),
    iconColor: "text-gray-400",
    textColor: "text-gray-500",
  },
};

export function DataSourceContextLine(props: DataSourceContextLineProps) {
  const derived = derive(props);
  if (!derived) return null;

  const { tier, body } = derived;
  const t = TIER_STYLES[tier];

  return (
    <div
      className={cn(
        "flex items-start gap-1.5 text-[12.5px] leading-relaxed max-w-[56ch]",
        t.textColor,
        props.className,
      )}
    >
      <span className={cn("shrink-0 mt-0.5", t.iconColor)} aria-hidden="true">
        {t.icon}
      </span>
      <span>{body}</span>
    </div>
  );
}
