import type { ReadinessResult } from "@/lib/disputes/strength-scoring";

/**
 * ReadinessRail — readout #3 of the Block C three-axis strength model (§1a/§1b).
 *
 * Surfaces the MVDL *readiness* axis (has the user supplied what's needed to
 * SEND?) — distinct from evidence strength (how provable) and data trust (can
 * we trust the bill). Renders the design's "Strengthen this letter" header +
 * progress meter + the four MVDL-required statuses.
 *
 * Status only — the actionable CTAs (re-run audit, add address, upload, re-draft)
 * live in the sibling <EvidenceGaps> card mounted below this in the rail, so the
 * CTA wiring is reused, not duplicated. `optionalOpen` is summarised as a pointer
 * to that card rather than re-listed here.
 *
 * Pure presentational; consumes only `readiness` from the GET `strength` payload.
 */

const STATE_PRESENTATION: Record<
  ReadinessResult["state"],
  { label: string; segment: string; pill: string; bar: string }
> = {
  airtight: {
    label: "Airtight",
    segment: "bg-emerald-500",
    pill: "border-emerald-200 bg-emerald-50 text-emerald-700",
    bar: "bg-emerald-100",
  },
  ready_to_send: {
    label: "Ready to send",
    segment: "bg-blue-500",
    pill: "border-blue-200 bg-blue-50 text-blue-700",
    bar: "bg-blue-100",
  },
  attention: {
    label: "Needs attention",
    segment: "bg-amber-500",
    pill: "border-amber-200 bg-amber-50 text-amber-800",
    bar: "bg-amber-100",
  },
};

const REQUIRED_LABELS: Array<{
  key: keyof ReadinessResult["required"];
  label: string;
  hint: string;
}> = [
  {
    key: "dataTrustPass",
    label: "Bill totals verified",
    hint: "We could reconcile this bill's totals.",
  },
  {
    key: "backedClaim",
    label: "At least one backed claim",
    hint: "A plan citation, statutory hook, or EOB allowed-amount backs a disputed line.",
  },
  {
    key: "recipientAddress",
    label: "Recipient address on file",
    hint: "The printed letter needs an insurer and/or provider mailing address.",
  },
  {
    key: "patientIdentity",
    label: "Patient name confirmed",
    hint: "The bill's patient name matches your account (or you've confirmed it).",
  },
];

export function ReadinessRail({
  readiness,
}: {
  readiness: ReadinessResult | null | undefined;
}) {
  if (!readiness) return null;

  const state = STATE_PRESENTATION[readiness.state] ?? STATE_PRESENTATION.attention;
  const total = readiness.requiredTotal || REQUIRED_LABELS.length;
  const met = Math.min(readiness.requiredMet, total);
  const optionalCount = readiness.optionalOpen?.length ?? 0;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Letter readiness
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            {met}/{total} required item{total === 1 ? "" : "s"} complete
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${state.pill}`}
        >
          {state.label}
        </span>
      </div>

      {/* Progress meter — segments = required floor; fill = items met. */}
      <div className="mt-4 flex gap-1.5" aria-hidden>
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className={`h-2 flex-1 rounded-full ${i < met ? state.segment : state.bar}`}
          />
        ))}
      </div>

      {/* The four MVDL-required statuses. */}
      <ul className="mt-4 space-y-2.5">
        {REQUIRED_LABELS.map((item) => {
          const done = readiness.required[item.key];
          return (
            <li key={item.key} className="flex items-start gap-2.5">
              <StatusDot done={done} />
              <div className="min-w-0">
                <div
                  className={`text-sm font-medium ${done ? "text-slate-700" : "text-slate-900"}`}
                >
                  {item.label}
                </div>
                {!done ? (
                  <p className="mt-0.5 text-xs text-slate-500">{item.hint}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {optionalCount > 0 ? (
        <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
          {optionalCount} optional way{optionalCount === 1 ? "" : "s"} to strengthen this letter — see below.
        </p>
      ) : null}
    </section>
  );
}

function StatusDot({ done }: { done: boolean }) {
  if (done) {
    return (
      <span
        aria-label="complete"
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500"
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-label="incomplete"
      className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-slate-300"
    />
  );
}
