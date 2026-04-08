import type { Metadata } from "next";
import Link from "next/link";
import { CONSENT_DOCUMENTS } from "@/lib/consent/consent-documents";
import { LegalText } from "@/components/legal-text";

export const metadata: Metadata = {
  title: "Health Data Authorization",
  description: "Candid Health Data Upload Authorization. Understand how your medical documents are processed, stored, and protected.",
  alternates: { canonical: "/health-data" },
};

export default function HealthDataPage() {
  const healthDoc = CONSENT_DOCUMENTS.health_data_upload;

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <Link href="/" className="text-blue-600 hover:underline text-sm">
        &larr; Back to home
      </Link>
      <h1 className="mt-6 text-3xl font-bold text-gray-900">Consumer Health Data Privacy Policy</h1>
      <p className="mt-2 text-sm text-gray-500">
        Version {healthDoc.version} &middot; Effective {healthDoc.effectiveDate}
      </p>
      <div className="mt-8 prose prose-gray max-w-none">
        <LegalText text={healthDoc.fullText} />
      </div>
      <div className="mt-12 border-t pt-8 text-sm text-gray-500 space-y-2">
        <p>
          See also: <Link href="/terms" className="text-blue-600 hover:underline">Terms of Service</Link> &middot; <Link href="/privacy" className="text-blue-600 hover:underline">Privacy Policy</Link>
        </p>
      </div>
    </div>
  );
}
