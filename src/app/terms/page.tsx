import type { Metadata } from "next";
import Link from "next/link";
import { CONSENT_DOCUMENTS } from "@/lib/consent/consent-documents";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Candid Terms of Service. Read the terms governing your use of Candid medical bill auditing and insurance plan analysis services.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  const tosDoc = CONSENT_DOCUMENTS.tos;

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <Link href="/" className="text-blue-600 hover:underline text-sm">
        &larr; Back to home
      </Link>
      <h1 className="mt-6 text-3xl font-bold text-gray-900">Terms of Service</h1>
      <p className="mt-2 text-sm text-gray-500">
        Version {tosDoc.version} &middot; Effective {tosDoc.effectiveDate}
      </p>
      <div className="mt-8 prose prose-gray max-w-none">
        <pre className="whitespace-pre-wrap font-sans text-base text-gray-700 leading-relaxed">
          {tosDoc.fullText}
        </pre>
      </div>
      <div className="mt-12 border-t pt-8 text-sm text-gray-500 space-y-2">
        <p>
          See also: <Link href="/privacy" className="text-blue-600 hover:underline">Privacy Policy</Link> &middot; <Link href="/health-data" className="text-blue-600 hover:underline">Health Data Consent</Link>
        </p>
      </div>
    </div>
  );
}
