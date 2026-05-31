/**
 * EvidenceBlock — Phase 4 UI rendering of DisputeEvidence.
 *
 * Renders the same "Why this should be covered" section that the letter body
 * includes, so the on-page UI mirrors what the downloaded letter says.
 * Graceful degradation: returns null when evidence is empty or only contains
 * noise (no plan benefit, no discrepancy).
 *
 * Phase 4 Task 4-E: when `gateUnverified` prop is true, applies the 3-case
 * cite-grade gating logic per Q-DR-4E-2 LOCK to the planBenefit-derived UI:
 *   Case 1 (cite-grade verified): full quote + blockquote
 *   Case 2 (covered + cost-sharing populated, no cite-grade): plan-specifies
 *          line WITHOUT blockquote
 *   Case 3 (no cite-grade AND no certainty): drop planBenefit-derived UI
 *          entirely (caller-side prompts to upload a more complete plan doc
 *          via the `<VerifyAffordance>` component)
 *
 * EOB / community / sibling-codes / pricing-benchmark UI is NOT gated — those
 * signals are independent of plan-data trust and remain useful regardless.
 *
 * S74 Pillar 2 — per-citation badges:
 *   - "Cite-grade verified · from your plan" (citationSource='user_doc')
 *   - "Cite-grade verified · from a similar member's plan" (citationSource='canonical_fallback')
 *   - "Cite-grade verified" (citationSource='legacy_sbc_excerpt' — pre-P-8 data)
 *   - "Plan data on file · not yet verbatim-verified" (sbcExcerptVerified=false)
 * Plus inline "Re-draft to verify" hint when the row is not cite-grade.
 */
import type { DisputeEvidence, LineItemEvidence } from "@/lib/disputes/evidence-resolver";
import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";

interface Props {
  evidence: DisputeEvidence | null;
  planLabel: string | null;
  /** Phase 4 Task 4-E. When true, plan-benefit blockquote rendering is gated by
   *  Pattern P-8 cite-grade verification per Q-P4-2 LOCK (legal surface). */
  gateUnverified?: boolean;
  /**
   * Block C (dispute_letter_v3_design) — when true, render the gated corroborating
   * evidence slots (community "what others paid", pricing benchmark, peer-code
   * coding suggestion) that mirror the letter body. Each slot is null-guarded +
   * hidden when empty (engines emit nothing on empty PROD per k-anon ≥5 / ≥2-peer
   * floors), so they auto-light when the flywheel fills. Default false → flag-OFF
   * UI is byte-identical to pre-Block-C.
   */
  showExtendedSlots?: boolean;
}

export function EvidenceBlock({
  evidence,
  planLabel,
  gateUnverified = false,
  showExtendedSlots = false,
}: Props) {
  if (!evidence || evidence.claims.length === 0) return null;

  // Section shows when any line has plan-benefit or discrepancy prose. In v3,
  // also show when a line carries a corroborating slot, so a line backed only
  // by cross-user evidence isn't hidden.
  const useful = evidence.claims.flatMap((c) =>
    c.lineItemEvidence.filter(
      (li) =>
        li.planBenefit ||
        li.discrepancyReason ||
        (showExtendedSlots &&
          (li.communityOutcome ||
            li.pricingBenchmark ||
            (li.peerCodes && li.peerCodes.length >= 2))),
    ),
  );
  if (useful.length === 0) return null;

  return (
    <div className="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-5 md:p-6">
      <div className="text-sm font-semibold uppercase tracking-wide text-indigo-700">
        Why this should be covered
      </div>
      <p className="mt-1 text-sm text-slate-600">
        Plain-language evidence drawn from your plan + this bill. The same
        analysis is embedded in your downloadable letter.
      </p>
      <ol className="mt-4 space-y-4">
        {evidence.claims.map((claim) =>
          claim.lineItemEvidence.map((li, idx) => (
            <EvidenceItem
              key={`${claim.claimId}-${li.lineItemId}-${idx}`}
              item={li}
              planLabel={planLabel}
              gateUnverified={gateUnverified}
              showExtendedSlots={showExtendedSlots}
            />
          )),
        )}
      </ol>
    </div>
  );
}

function EvidenceItem({
  item,
  planLabel,
  gateUnverified,
  showExtendedSlots,
}: {
  item: LineItemEvidence;
  planLabel: string | null;
  gateUnverified: boolean;
  showExtendedSlots: boolean;
}) {
  const codeLabel = item.billingCode
    ? `${item.billingCode.type} ${item.billingCode.value}`
    : null;

  // Phase 4 Task 4-E: 3-case gating per Q-DR-4E-2 LOCK. When `gateUnverified`
  // is false (legacy / flag OFF), planBenefitTrusted is always true → all bullets
  // render unconditionally (byte-identical legacy behavior).
  const planBenefitTrusted = !!(
    item.planBenefit &&
    (!gateUnverified ||
      item.planBenefit.sbcExcerptVerified ||
      (item.planBenefit.covered === true &&
        (item.planBenefit.copay !== null || item.planBenefit.coinsurance !== null)))
  );
  const showBlockquote = !!(
    item.planBenefit?.sbcExcerpt &&
    (!gateUnverified || item.planBenefit.sbcExcerptVerified)
  );

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="font-semibold text-slate-900">{item.serviceName}</div>
          {codeLabel ? (
            <div className="text-xs uppercase tracking-wide text-slate-500">
              {codeLabel}
            </div>
          ) : null}
        </div>
        <div className="text-sm text-slate-500">
          Billed {formatUsd(item.billedAmount)}
        </div>
      </div>

      <div className="mt-3 space-y-2 text-sm">
        {item.planBenefit && planBenefitTrusted ? (
          <div className="text-slate-700">
            <span className="font-medium text-slate-900">
              {planLabel ?? "Your plan"}
            </span>{" "}
            specifies{" "}
            {item.planBenefit.copay != null ? (
              <span className="font-semibold">
                a {formatUsd(item.planBenefit.copay)} copay
              </span>
            ) : item.planBenefit.coinsurance != null ? (
              <span className="font-semibold">
                {normalizeCoinsurancePct(item.planBenefit.coinsurance)}% coinsurance
              </span>
            ) : (
              "cost-sharing terms"
            )}{" "}
            for this service.
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>{item.planBenefit.citation}</span>
              <CitationBadge
                verified={item.planBenefit.sbcExcerptVerified}
                citationSource={item.planBenefit.citationSource}
              />
            </div>
            {showBlockquote ? (
              <blockquote className="mt-2 border-l-2 border-indigo-200 pl-3 text-slate-700 italic">
                &ldquo;{item.planBenefit.sbcExcerpt!.trim()}&rdquo;
              </blockquote>
            ) : null}
            {!item.planBenefit.sbcExcerptVerified ? (
              <div className="mt-2 text-xs italic text-slate-500">
                We have copay / coinsurance values on file but haven&apos;t found a verbatim
                quote in your plan document. <span className="font-medium not-italic text-slate-700">Use Re-draft</span> to attempt a cite-grade upgrade.
              </div>
            ) : null}
          </div>
        ) : null}

        {item.insurancePaid != null || item.patientOwes != null ? (
          <div className="text-slate-600">
            EOB shows:{" "}
            <span>{formatUsd(item.billedAmount)} billed</span>
            {" · "}
            <span>{formatUsd(item.insurancePaid ?? 0)} insurance paid</span>
            {" · "}
            <span>{formatUsd(item.patientOwes ?? 0)} patient responsibility</span>
          </div>
        ) : null}

        {item.discrepancyAmount != null && item.discrepancyAmount > 0 && planBenefitTrusted ? (
          <div className="text-slate-900">
            Expected patient cost per plan:{" "}
            <span className="font-semibold">
              {formatUsd(item.expectedPatientCost ?? 0)}
            </span>
            . Actual:{" "}
            <span className="font-semibold">
              {formatUsd(item.actualPatientCost ?? 0)}
            </span>
            .{" "}
            <span className="font-semibold text-rose-700">
              Discrepancy: {formatUsd(item.discrepancyAmount)}.
            </span>
          </div>
        ) : item.discrepancyReason && planBenefitTrusted ? (
          <div className="text-slate-700">{item.discrepancyReason}</div>
        ) : null}

        {/* Block C — gated corroborating slots. Each null-guarded; the engines
            emit nothing on empty PROD (k-anon ≥5 / ≥2-peer floors), so these
            auto-light only when the flywheel fills. Mirrors the letter body
            bullets (templates.ts). v3-only via showExtendedSlots. */}
        {showExtendedSlots ? <ExtendedSlots item={item} /> : null}
      </div>
    </li>
  );
}

/**
 * Block C corroborating-evidence slots — the on-page mirror of the letter's
 * community / benchmark / peer-code bullets. Phrasing matches templates.ts
 * (AMA-compliant for peer codes: "verify whether X more accurately reflects",
 * never "should be coded as X"). Renders nothing when no slot has data.
 */
function ExtendedSlots({ item }: { item: LineItemEvidence }) {
  const community = item.communityOutcome;
  const pricing = item.pricingBenchmark;
  const peers = item.peerCodes && item.peerCodes.length >= 2 ? item.peerCodes : null;

  const hasCommunity = !!community && community.totalClaims > 0;
  const hasPricing = !!pricing && pricing.medianBilled != null && item.billedAmount > 0;
  if (!hasCommunity && !hasPricing && !peers) return null;

  return (
    <div className="space-y-2 border-t border-slate-100 pt-2">
      {hasCommunity ? (
        <div className="text-slate-600">
          <SlotLabel>What others paid</SlotLabel>{" "}
          {community!.paidCount > 0
            ? `${community!.paidCount} of ${community!.totalClaims} claims for this code on this plan have been paid`
            : `${community!.totalClaims} claims for this code on this plan are on record`}
          {community!.avgPaidAmount != null && community!.paidCount > 0
            ? `; average payment ${formatUsd(community!.avgPaidAmount)}`
            : ""}
          .{" "}
          <span className="text-slate-400">(anonymized, aggregated Candid member data)</span>
        </div>
      ) : null}

      {hasPricing ? (
        <div className="text-slate-600">
          <SlotLabel>Benchmark</SlotLabel>{" "}
          Median billed rate for this code
          {pricing!.region ? ` in ${pricing!.region}` : ""} is{" "}
          <span className="font-semibold">{formatUsd(pricing!.medianBilled!)}</span> across{" "}
          {pricing!.sampleSize} anonymized member report
          {pricing!.sampleSize === 1 ? "" : "s"}.
        </div>
      ) : null}

      {peers ? (
        <div className="text-slate-600">
          <SlotLabel>Coding</SlotLabel>{" "}
          Similar charges have been resolved when re-coded. Please verify whether{" "}
          <span className="font-semibold">{peers[0].code}</span> more accurately
          reflects the service provided, and reprocess accordingly if applicable.
        </div>
      ) : null}
    </div>
  );
}

function SlotLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
      {children}:
    </span>
  );
}

function formatUsd(n: number): string {
  const v = Math.round(n * 100) / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * S74 Pillar 2 — per-citation provenance badge. Sits next to the SBC page reference
 * so the user can tell at a glance whether the blockquote came from their own plan
 * doc, another member's parse of the same canonical plan, or a legacy pre-P-8 row.
 */
function CitationBadge({
  verified,
  citationSource,
}: {
  verified: boolean;
  citationSource: LineItemEvidence["planBenefit"] extends infer T
    ? T extends { citationSource: infer S } ? S : never
    : never;
}) {
  if (!verified) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
        title="Plan-benefit values are on file but we haven't yet matched them to a verbatim plan-document quote. Re-draft attempts a cite-grade upgrade."
      >
        <Dot tone="amber" /> Plan data on file
      </span>
    );
  }
  if (citationSource === "user_doc") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800"
        title="Verbatim quote extracted from your uploaded plan document."
      >
        <Dot tone="emerald" /> Verified from your plan
      </span>
    );
  }
  if (citationSource === "canonical_fallback") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800"
        title="Your row didn't carry a verbatim quote yet, so we cited another member's verified parse of this same plan. Pattern 1 #3 corroboration in action."
      >
        <Dot tone="emerald" /> Verified · community-cited
      </span>
    );
  }
  // legacy_sbc_excerpt (pre-Pattern P-8) — still cite-grade in spirit but not in
  // the modern source_excerpt_verified sense.
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700"
      title="Citation drawn from a legacy plan-document parse (pre-Pattern P-8). Quality is generally good but lacks per-field verbatim verification."
    >
      <Dot tone="slate" /> Verified · legacy
    </span>
  );
}

function Dot({ tone }: { tone: "emerald" | "amber" | "slate" }) {
  const color =
    tone === "emerald"
      ? "bg-emerald-500"
      : tone === "amber"
      ? "bg-amber-500"
      : "bg-slate-400";
  return <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${color}`} />;
}
