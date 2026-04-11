"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import type { DisputeLetter } from "@/lib/billing/types";
import { SubscriptionGate } from "@/lib/subscription/subscription-gate";
import { downloadCaseFile } from "@/lib/casefile";

export default function DisputesPage() {
  return (
    <SubscriptionGate requiredTier="pro" featureName="Dispute Letters">
      <Suspense>
        <DisputesContent />
      </Suspense>
    </SubscriptionGate>
  );
}

function DisputesContent() {
  const searchParams = useSearchParams();
  const [letter, setLetter] = useState<DisputeLetter | null>(null);
  const [editedBody, setEditedBody] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const letterParam = searchParams.get("letter");
    if (letterParam) {
      try {
        const parsed = JSON.parse(decodeURIComponent(letterParam));
        setLetter(parsed);
        setEditedBody(parsed.body);
      } catch {
        // Invalid letter data
      }
    }
  }, [searchParams]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(editedBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      if (textRef.current) {
        textRef.current.select();
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  };

  const handleDownload = () => {
    const blob = new Blob([editedBody], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `candid-dispute-letter-${letter?.letterType || "general"}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadCaseFile = () => {
    if (!letter) return;
    // Use the edited body so any user edits are included
    downloadCaseFile({ ...letter, body: editedBody });
  };

  if (!letter) {
    return (
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Dispute Letters</h1>
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-6xl mb-4">📝</div>
          <h2 className="text-xl font-semibold mb-2">No letter generated yet</h2>
          <p className="text-gray-600 mb-4">
            Run an{" "}
            <a href="/audit" className="text-blue-600 hover:underline">
              audit on your bill
            </a>{" "}
            first, then select findings to generate a dispute letter.
          </p>
          <p className="text-gray-500 text-sm">
            You can also request an itemized bill without an audit.
          </p>
          <RequestItemizedBill />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Dispute Letter</h1>
      <p className="text-gray-600 mb-6">
        Review and edit your letter below. When ready, download or copy it and
        send it yourself.
      </p>

      {/* Letter metadata */}
      <div className="bg-white rounded-lg shadow p-5 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-gray-500">Type:</span>{" "}
            <span className="font-medium capitalize">
              {letter.letterType.replace("_", " ")}
            </span>
          </div>
          <div>
            <span className="text-gray-500">To:</span>{" "}
            <span className="font-medium">
              {letter.recipient.name} — {letter.recipient.role}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Action:</span>{" "}
            <span className="font-medium">{letter.requestedAction}</span>
          </div>
        </div>
      </div>

      {/* Important notice */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4 text-sm">
        <strong className="text-amber-800">Important:</strong>{" "}
        <span className="text-amber-700">
          Review this letter carefully and make any edits needed. You must send
          this letter yourself — Candid does not submit letters on your behalf.
          Consider consulting an attorney if your dispute involves significant
          amounts.
        </span>
      </div>

      {/* Letter body */}
      <div className="bg-white rounded-lg shadow">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold">
            {letter.subject}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => setIsEditing(!isEditing)}
              className="text-sm px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
            >
              {isEditing ? "Preview" : "Edit"}
            </button>
            <button
              onClick={handleCopy}
              className="text-sm px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              onClick={handleDownload}
              className="text-sm px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
            >
              Letter Only
            </button>
            <button
              onClick={handleDownloadCaseFile}
              className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 font-medium"
            >
              Download Case File
            </button>
          </div>
        </div>

        {isEditing ? (
          <textarea
            ref={textRef}
            value={editedBody}
            onChange={(e) => setEditedBody(e.target.value)}
            className="w-full p-6 font-mono text-sm min-h-[600px] resize-y focus:outline-none"
          />
        ) : (
          <div className="p-6 whitespace-pre-wrap font-mono text-sm leading-relaxed">
            {editedBody}
          </div>
        )}
      </div>

      {/* Legal basis */}
      {letter.legalBasis && (
        <div className="bg-gray-50 rounded-lg p-4 mt-4 text-sm">
          <span className="text-gray-500">Legal basis referenced:</span>{" "}
          <span className="text-gray-700">{letter.legalBasis}</span>
        </div>
      )}

      {/* Case File callout */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-5 mt-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-blue-900 mb-1">Download your full Case File</h3>
            <p className="text-sm text-blue-800 mb-3">
              The Case File bundles everything you need to fight this claim: your dispute
              letter, audit findings, evidence log, a 30-day follow-up checklist, and an
              escalation guide if the dispute isn&apos;t resolved.
            </p>
            <ul className="text-sm text-blue-700 space-y-1">
              <li>✓ Dispute letter (including any edits you made)</li>
              <li>✓ Audit findings &amp; evidence summary</li>
              <li>✓ Step-by-step sending instructions</li>
              <li>✓ 30-day follow-up reminder date</li>
              <li>✓ Escalation guide (state agencies, external review, attorney)</li>
            </ul>
          </div>
          <button
            onClick={handleDownloadCaseFile}
            className="shrink-0 bg-blue-600 text-white px-5 py-2.5 rounded-lg hover:bg-blue-700 font-medium text-sm whitespace-nowrap"
          >
            Download Case File
          </button>
        </div>
      </div>

      {/* Next steps */}
      <div className="bg-white rounded-lg shadow p-5 mt-4">
        <h3 className="font-semibold mb-3">Next Steps</h3>
        <ol className="text-sm text-gray-700 space-y-2 list-decimal list-inside">
          <li>Review your letter above and make any edits needed.</li>
          <li>
            Send via certified mail with return receipt (USPS Form 3811) — this
            creates a paper trail.
          </li>
          <li>Keep a copy of the signed letter and this case file in your records.</li>
          <li>Follow up if you don&apos;t hear back within 30 days.</li>
          <li>
            If unresolved, escalate to your state Insurance Commissioner or consider
            consulting a healthcare attorney.
          </li>
        </ol>
      </div>

      {/* Dispute tracking */}
      <div className="bg-white rounded-lg shadow p-5 mt-4">
        <h3 className="font-semibold mb-2">Track This Dispute</h3>
        <p className="text-sm text-gray-500 mb-3">
          Track the outcome of this dispute on the{" "}
          <a href="/claim" className="text-blue-600 hover:underline">Claims page</a>.
          Recording outcomes helps Candid calculate success rates and helps other users with similar disputes.
        </p>
      </div>
    </div>
  );
}

function RequestItemizedBill() {
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({
    patientName: "",
    providerName: "",
    serviceDate: "",
    accountNumber: "",
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/disputes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, type: "itemized_request" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const letterData = encodeURIComponent(JSON.stringify(data.letter));
      window.location.href = `/disputes?letter=${letterData}`;
    } catch {
      alert("Failed to generate letter. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className="mt-4 text-sm text-blue-600 hover:underline"
      >
        Request an itemized bill instead
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 text-left max-w-md mx-auto space-y-3">
      <input
        type="text"
        placeholder="Your full name"
        required
        value={form.patientName}
        onChange={(e) => setForm({ ...form, patientName: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <input
        type="text"
        placeholder="Provider / Hospital name"
        required
        value={form.providerName}
        onChange={(e) => setForm({ ...form, providerName: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <input
        type="date"
        required
        value={form.serviceDate}
        onChange={(e) => setForm({ ...form, serviceDate: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <input
        type="text"
        placeholder="Account # (optional)"
        value={form.accountNumber}
        onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm"
      >
        {loading ? "Generating..." : "Generate Itemized Bill Request"}
      </button>
    </form>
  );
}
