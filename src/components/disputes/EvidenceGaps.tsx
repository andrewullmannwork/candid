/**
 * EvidenceGaps — surfaces missing-evidence prompts with actionable CTAs.
 *
 * Rendered below the EvidenceBlock on /disputes when the resolver flagged
 * signals we couldn't populate. Each gap is one of:
 *   - a navigation CTA (Link to /upload?planYear=...&returnTo=...)
 *   - an inline action — audit_findings_missing → POST rerun-audit endpoint;
 *     cite_grade_incomplete → POST redraft endpoint;
 *     provider_address_missing → inline ProviderAddressForm POSTs to
 *     /api/disputes/[disputeId]/provider-contact.
 *
 * The /disputes page refetches on window focus AND awaits each callback,
 * so dynamic state hydrates either way.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import type { EvidenceGap } from "@/lib/disputes/evidence-resolver";
import { ProviderAddressForm } from "./ProviderAddressForm";

interface ProviderContactSeed {
  name: string | null;
  address: string | null;
  phone: string | null;
  npi: string | null;
}

interface Props {
  gaps: EvidenceGap[];
  /**
   * Called when the user clicks "Re-run audit" on the
   * `audit_findings_missing` gap. Should run the rerun-audit POST and then
   * refetch the dispute. The component handles its own loading state.
   */
  onAuditRerun?: () => Promise<void>;
  /**
   * S74 — called when the user clicks "Re-draft" on the `cite_grade_incomplete`
   * gap. Should POST to /api/disputes/[disputeId]/redraft and then refetch.
   */
  onRedraft?: () => Promise<void>;
  /**
   * S74 — disputeId + auth helper + seed values are required for the inline
   * ProviderAddressForm rendered under the `provider_address_missing` gap.
   */
  disputeId?: string | null;
  providerSeed?: ProviderContactSeed | null;
  getAuthToken?: () => Promise<string | null>;
  /** Called after a provider-contact save succeeds so parent can refetch. */
  onProviderContactSaved?: () => Promise<void>;
  /**
   * S111 D6 — called when the user clicks "Upload my {year} plan" on the
   * `bound_canonical_coverage_thin` gap. Opens PlanSearchModal in upload
   * mode (the gap CTA routes to in-modal upload, not a navigation, so
   * existing ctaHref pattern doesn't fit — parent owns modal state).
   */
  onUploadInModal?: () => void;
}

export function EvidenceGaps({
  gaps,
  onAuditRerun,
  onRedraft,
  disputeId,
  providerSeed,
  getAuthToken,
  onProviderContactSaved,
  onUploadInModal,
}: Props) {
  const [rerunStatus, setRerunStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [redraftStatus, setRedraftStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [providerFormOpen, setProviderFormOpen] = useState(false);

  if (!gaps || gaps.length === 0) return null;

  const handleAuditRerun = async () => {
    if (!onAuditRerun || rerunStatus === "running") return;
    setRerunStatus("running");
    try {
      await onAuditRerun();
      setRerunStatus("done");
    } catch {
      setRerunStatus("error");
    }
  };

  const handleRedraft = async () => {
    if (!onRedraft || redraftStatus === "running") return;
    setRedraftStatus("running");
    try {
      await onRedraft();
      setRedraftStatus("done");
    } catch {
      setRedraftStatus("error");
    }
  };

  return (
    <section className="@container rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Strengthen this letter
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Add any of the items below and your letter will automatically update
          the next time you return to this page.
        </p>
      </div>
      <ul className="space-y-3">
        {gaps.map((gap, i) => {
          const expandedForm =
            gap.kind === "provider_address_missing" &&
            providerFormOpen &&
            disputeId &&
            getAuthToken;
          return (
            <li
              key={`${gap.kind}-${i}`}
              className="rounded-xl border border-slate-100 bg-slate-50/50 px-4 py-3"
            >
              <div className="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <GapIcon />
                    <div className="font-semibold text-slate-900">{gap.title}</div>
                  </div>
                  <p className="mt-1 pl-6 text-sm text-slate-600">{gap.description}</p>
                </div>
                {renderCta(gap, {
                  onAuditRerun: handleAuditRerun,
                  onRedraft: handleRedraft,
                  rerunStatus,
                  redraftStatus,
                  hasAuditCallback: !!onAuditRerun,
                  hasRedraftCallback: !!onRedraft,
                  onOpenProviderForm: () => setProviderFormOpen(true),
                  providerFormOpen,
                  hasProviderContext: !!disputeId && !!getAuthToken,
                  onUploadInModal,
                })}
              </div>
              {expandedForm ? (
                <ProviderAddressForm
                  disputeId={disputeId}
                  initialName={providerSeed?.name ?? null}
                  initialAddress={providerSeed?.address ?? null}
                  initialPhone={providerSeed?.phone ?? null}
                  initialNpi={providerSeed?.npi ?? null}
                  getAuthToken={getAuthToken}
                  onSaved={async () => {
                    await onProviderContactSaved?.();
                    setProviderFormOpen(false);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function renderCta(
  gap: EvidenceGap,
  ctx: {
    onAuditRerun: () => void;
    onRedraft: () => void;
    rerunStatus: "idle" | "running" | "done" | "error";
    redraftStatus: "idle" | "running" | "done" | "error";
    hasAuditCallback: boolean;
    hasRedraftCallback: boolean;
    onOpenProviderForm: () => void;
    providerFormOpen: boolean;
    hasProviderContext: boolean;
    onUploadInModal?: () => void;
  },
) {
  if (gap.kind === "audit_findings_missing" && ctx.hasAuditCallback) {
    const label =
      ctx.rerunStatus === "running"
        ? "Re-running audit…"
        : ctx.rerunStatus === "done"
        ? "Audit refreshed ✓"
        : ctx.rerunStatus === "error"
        ? "Try again"
        : (gap.ctaLabel ?? "Re-run audit");
    return (
      <button
        type="button"
        onClick={ctx.onAuditRerun}
        disabled={ctx.rerunStatus === "running"}
        className="inline-flex shrink-0 items-center justify-center rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow disabled:cursor-wait disabled:opacity-70 @md:ml-4"
      >
        {label}
      </button>
    );
  }

  // S74 — cite-grade incomplete: invoke the toolbar Re-draft via callback.
  if (gap.kind === "cite_grade_incomplete" && ctx.hasRedraftCallback) {
    const label =
      ctx.redraftStatus === "running"
        ? "Re-drafting…"
        : ctx.redraftStatus === "done"
        ? "Re-draft complete ✓"
        : ctx.redraftStatus === "error"
        ? "Try again"
        : (gap.ctaLabel ?? "Re-draft letter");
    return (
      <button
        type="button"
        onClick={ctx.onRedraft}
        disabled={ctx.redraftStatus === "running"}
        className="inline-flex shrink-0 items-center justify-center rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow disabled:cursor-wait disabled:opacity-70 @md:ml-4"
      >
        {label}
      </button>
    );
  }

  // S111 D6 — bound canonical coverage thin: route CTA to in-modal upload
  // (PlanSearchModal upload mode) rather than navigating to /upload, since
  // upload-in-modal is the design integration target for this gap (no
  // out-of-modal redirect breaks the dispute view's flow).
  if (gap.kind === "bound_canonical_coverage_thin" && ctx.onUploadInModal) {
    return (
      <button
        type="button"
        onClick={ctx.onUploadInModal}
        className="inline-flex shrink-0 items-center justify-center rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow @md:ml-4"
      >
        {gap.ctaLabel ?? "Upload my plan"}
      </button>
    );
  }

  // S74 — provider address missing: open the inline form.
  if (gap.kind === "provider_address_missing" && ctx.hasProviderContext) {
    return (
      <button
        type="button"
        onClick={ctx.onOpenProviderForm}
        className="inline-flex shrink-0 items-center justify-center rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow @md:ml-4"
      >
        {ctx.providerFormOpen ? "Form open below" : "Add provider address"}
      </button>
    );
  }

  if (gap.ctaLabel && gap.ctaHref) {
    return (
      <Link
        href={gap.ctaHref}
        className="inline-flex shrink-0 items-center justify-center rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow @md:ml-4"
      >
        {gap.ctaLabel}
      </Link>
    );
  }

  return null;
}

function GapIcon() {
  return (
    <svg
      className="h-4 w-4 text-amber-500"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
