"use client";

import { useCallback, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { cn } from "@/lib/utils/cn";
import CategoryGrid, { type SupportCategoryId } from "@/components/support/CategoryGrid";
import DocumentLinkPicker from "@/components/support/DocumentLinkPicker";
import AttachmentDropzone from "@/components/support/AttachmentDropzone";
import SupportRail from "@/components/support/SupportRail";

interface Props {
  faqEnabled: boolean;
}

const CHAR_LIMIT = 1500;
const SUBJECT_LIMIT = 120;

function shortIdFrom(uuid: string): string {
  // First 5 hex chars (uppercased) from the UUID for display: CN-A1B2C
  return uuid.replace(/-/g, "").slice(0, 5).toUpperCase();
}

export default function SupportClient({ faqEnabled }: Props) {
  const { user } = useAuth();
  const [category, setCategory] = useState<SupportCategoryId | null>(null);
  const [subject, setSubject] = useState("");
  const [details, setDetails] = useState("");
  const [linkedDocumentId, setLinkedDocumentId] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ ticketId: string } | null>(null);
  const [error, setError] = useState("");

  const charsLeft = CHAR_LIMIT - details.length;
  const charWarn = charsLeft < 100;

  const canSubmit =
    !!category &&
    subject.trim().length > 2 &&
    details.trim().length > 10 &&
    consent &&
    !submitting;

  // Why-disabled hint (smoke fix S123#2 — Andrew couldn't tell why Submit was
  // greyed out when "Test 3" was below the 10-char details threshold). Show
  // the FIRST unmet requirement so the user knows exactly what to fix.
  let missingHint: string | null = null;
  if (!submitting) {
    if (!category) {
      missingHint = "Pick a category above";
    } else if (subject.trim().length <= 2) {
      missingHint = "Add a subject (at least 3 characters)";
    } else if (details.trim().length <= 10) {
      const needed = 11 - details.trim().length;
      missingHint = `Add ${needed} more character${needed === 1 ? "" : "s"} to Details`;
    } else if (!consent) {
      missingHint = "Check the consent box";
    }
  }

  const getIdToken = useCallback(async () => {
    if (!user) throw new Error("Not authenticated");
    return user.firebaseUser.getIdToken();
  }, [user]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !user) return;
    setSubmitting(true);
    setError("");

    try {
      const token = await getIdToken();

      // Use multipart if attachment present, JSON otherwise (matches API contract)
      let res: Response;
      if (attachment) {
        const form = new FormData();
        form.append("category", category!);
        form.append("subject", subject.trim());
        form.append("body", details.trim());
        if (linkedDocumentId) form.append("linkedDocumentId", linkedDocumentId);
        form.append("attachment", attachment);
        res = await fetch("/api/support", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
      } else {
        res = await fetch("/api/support", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            category,
            subject: subject.trim(),
            body: details.trim(),
            linkedDocumentId,
          }),
        });
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit ticket");
      }

      const data = await res.json();
      setSubmitted({ ticketId: data.ticket_id });
      // Reset form state
      setCategory(null);
      setSubject("");
      setDetails("");
      setLinkedDocumentId(null);
      setAttachment(null);
      setConsent(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit ticket. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Success screen
  if (submitted) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 mb-6">
          <svg width={28} height={28} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Ticket submitted</h2>
        <p className="mt-3 text-gray-600 max-w-md mx-auto">
          Thanks — we got it. A real person on the Candid team will reply by email, usually within 24 hours.
        </p>
        <div className="inline-flex items-center gap-2 mt-6 px-4 py-2 rounded-lg bg-gray-100 text-sm">
          <span className="text-gray-500 uppercase text-xs font-semibold">Ticket</span>
          <span className="font-mono text-gray-900">#CN-{shortIdFrom(submitted.ticketId)}</span>
        </div>
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setSubmitted(null)}
            className="px-5 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Submit another ticket
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          We&apos;re listening
        </div>
        <h1 className="mt-2 text-3xl font-bold text-gray-900">How can we help?</h1>
        <p className="mt-2 text-gray-600 max-w-2xl">
          Tell us what&apos;s going on. The more detail you give us, the faster we can get you a real, useful answer — usually within 24 hours.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Form (left, 2 cols on lg) */}
        <form onSubmit={handleSubmit} className="lg:col-span-2 space-y-8">
          {/* Section 1 — Category */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-700 text-xs font-bold">1</span>
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">What&apos;s this about?</h2>
            </div>
            <CategoryGrid value={category} onChange={setCategory} />
          </section>

          {/* Section 2 — Details */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-700 text-xs font-bold">2</span>
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Tell us the details</h2>
            </div>

            <div className="space-y-4">
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label htmlFor="sp-subject" className="text-sm font-medium text-gray-700">Subject</label>
                  <span className="text-xs text-gray-500">A short summary</span>
                </div>
                <input
                  id="sp-subject"
                  type="text"
                  maxLength={SUBJECT_LIMIT}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g. Anthem EOB flagged a $340 duplicate code"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label htmlFor="sp-details" className="text-sm font-medium text-gray-700">Details</label>
                  <span className="text-xs text-gray-500">Dates, dollar amounts, providers all help.</span>
                </div>
                <div className="relative">
                  <textarea
                    id="sp-details"
                    maxLength={CHAR_LIMIT}
                    value={details}
                    onChange={(e) => setDetails(e.target.value)}
                    rows={6}
                    placeholder={"What happened? What were you expecting?\n\nIf this is about a specific bill or claim, paste the line item or code here."}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y"
                  />
                  <span className={cn(
                    "absolute bottom-2 right-3 text-xs font-medium",
                    charWarn ? "text-amber-600" : "text-gray-400",
                  )}>
                    {details.length}/{CHAR_LIMIT}
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* Section 3 — Context (optional) */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-700 text-xs font-bold">3</span>
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
                Add context <span className="ml-1 text-gray-400 normal-case tracking-normal font-medium">· optional</span>
              </h2>
            </div>

            <div className="space-y-4">
              {category === "bill" && (
                <div>
                  <label className="text-sm font-medium text-gray-700 mb-2 block">
                    Link a document <span className="text-gray-400 font-normal">— optional</span>
                  </label>
                  <DocumentLinkPicker
                    value={linkedDocumentId}
                    onChange={setLinkedDocumentId}
                    getIdToken={getIdToken}
                  />
                </div>
              )}

              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700">
                    Attach a file <span className="text-gray-400 font-normal">— optional</span>
                  </label>
                </div>
                <AttachmentDropzone value={attachment} onChange={setAttachment} />
              </div>
            </div>
          </section>

          {/* Consent */}
          <section>
            <label className="flex items-start gap-3 p-4 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">
                <strong className="text-gray-900">Share the details I&apos;ve added with the Candid support team.</strong>{" "}
                We&apos;ll only look at what&apos;s needed to answer this ticket. Revoke this consent anytime from your account settings.
              </span>
            </label>
          </section>

          {/* Footer — HIPAA copy strike NON-NEGOTIABLE per D-§1.B.3-C */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-2 border-t border-gray-100">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
              <span>Encrypted in transit and at rest</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled
                title="Coming soon"
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-400 cursor-not-allowed"
              >
                Save draft
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className={cn(
                  "inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all",
                  canSubmit
                    ? "bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
                    : "bg-gray-200 text-gray-400 cursor-not-allowed",
                )}
              >
                {submitting ? "Submitting…" : "Submit ticket"}
                {!submitting && (
                  <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {missingHint && (
            <div className="text-right text-xs text-amber-700">
              {missingHint}
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
          )}
        </form>

        {/* Right rail */}
        <SupportRail faqEnabled={faqEnabled} />
      </div>
    </div>
  );
}
