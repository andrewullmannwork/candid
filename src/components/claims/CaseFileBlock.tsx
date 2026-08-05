"use client";

/**
 * CaseFileBlock — S305. The record, where the user is.
 *
 * Placement is the design (spec §1): below the rail, at the claim's outer level,
 * OUTSIDE the fold wrapper. It is not a numbered step — it isn't something you
 * do, it's what everything you've done adds up to — so it never joins the rail's
 * badge sequence and it survives the collapse the rail's own steps don't.
 *
 * Two states, one document. While the case is live it names what it holds and
 * that it is lawyer-ready. When the case has ended in a denial it becomes the
 * primary thing on screen: the handoff, not a consolation prize.
 *
 * Absent before the first letter — there is no case to file.
 */
import { CASE_FILE } from "@/lib/guides/pack-registry";
import { useCaseFileDownload } from "@/lib/legal/use-case-file-download";

export function CaseFileBlock({
  claimId,
  getAuthToken,
  /** The case ended in a denial and the rail has collapsed behind it. */
  primary,
  updatedLabel,
  letters,
  calls,
  complaints,
}: {
  claimId: string;
  getAuthToken: () => Promise<string | null>;
  primary: boolean;
  updatedLabel: string | null;
  letters: number;
  calls: number;
  complaints: number;
}) {
  const { download, busy, failed } = useCaseFileDownload(getAuthToken);
  const meta = CASE_FILE.meta(updatedLabel, letters, calls, complaints);

  return (
    <section
      className={
        primary
          ? "mt-6 rounded-[18px] border border-blue-200 bg-gradient-to-br from-blue-50 to-white px-6 py-5"
          : "mt-6 rounded-[18px] border border-gray-200 bg-white px-6 py-5"
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-[58ch]">
          <h3 className={`text-sm font-bold ${primary ? "text-blue-900" : "text-gray-900"}`}>
            {primary ? CASE_FILE.titleDenied : CASE_FILE.title}
          </h3>
          <p className="mt-1 text-[13px] leading-[1.55] text-gray-600">
            {primary ? CASE_FILE.bodyDenied : CASE_FILE.body}
          </p>
          {meta && <p className="mt-2 text-[11.5px] text-gray-400">{meta}</p>}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void download(claimId, "text")}
            className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {CASE_FILE.ctaText}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void download(claimId, "pdf")}
            className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Preparing…" : CASE_FILE.ctaPdf}
          </button>
        </div>
      </div>
      {/* Failure is SHOWN. Both prior copies of this download swallowed it — one
          in an empty catch, one by handing over a different file without saying
          so (S305). */}
      {failed && <p className="mt-2 text-[12px] text-red-600">{CASE_FILE.failed}</p>}
    </section>
  );
}
