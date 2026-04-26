/**
 * EvidenceBlock — Phase 4 UI rendering of DisputeEvidence
 *
 * Renders the same "Why this should be covered" section that the letter body
 * includes, so the on-page UI mirrors what the downloaded letter says.
 * Graceful degradation: returns null when evidence is empty or only contains
 * noise (no plan benefit, no discrepancy).
 */
import type { DisputeEvidence, LineItemEvidence } from "@/lib/disputes/evidence-resolver";

interface Props {
  evidence: DisputeEvidence | null;
  planLabel: string | null;
}

export function EvidenceBlock({ evidence, planLabel }: Props) {
  if (!evidence || evidence.claims.length === 0) return null;

  const useful = evidence.claims.flatMap((c) =>
    c.lineItemEvidence.filter((li) => li.planBenefit || li.discrepancyReason),
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
}: {
  item: LineItemEvidence;
  planLabel: string | null;
}) {
  const codeLabel = item.billingCode
    ? `${item.billingCode.type} ${item.billingCode.value}`
    : null;

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
        {item.planBenefit ? (
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
                {Math.round(item.planBenefit.coinsurance * 100)}% coinsurance
              </span>
            ) : (
              "cost-sharing terms"
            )}{" "}
            for this service.
            <div className="mt-1 text-xs text-slate-500">{item.planBenefit.citation}</div>
            {item.planBenefit.sbcExcerpt ? (
              <blockquote className="mt-2 border-l-2 border-indigo-200 pl-3 text-slate-700 italic">
                &ldquo;{item.planBenefit.sbcExcerpt.trim()}&rdquo;
              </blockquote>
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

        {item.discrepancyAmount != null && item.discrepancyAmount > 0 ? (
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
        ) : item.discrepancyReason ? (
          <div className="text-slate-700">{item.discrepancyReason}</div>
        ) : null}
      </div>
    </li>
  );
}

function formatUsd(n: number): string {
  const v = Math.round(n * 100) / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
