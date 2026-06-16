import type { Metadata } from "next";
import Link from "next/link";
import { CONSENT_DOCUMENTS } from "@/lib/consent/consent-documents";
import { LegalText } from "@/components/legal-text";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Candid Privacy Policy. Learn how we protect your health data with HIPAA-grade safeguards and handle your personal information.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  const privacyDoc = CONSENT_DOCUMENTS.privacy_policy;

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <Link href="/" className="text-blue-600 hover:underline text-sm">
        &larr; Back to home
      </Link>
      <h1 className="mt-6 text-3xl font-bold text-gray-900">Privacy Policy</h1>
      <p className="mt-2 text-sm text-gray-500">
        Version {privacyDoc.version} &middot; Effective {privacyDoc.effectiveDate}
      </p>
      <div className="mt-8 prose prose-gray max-w-none">
        <LegalText text={privacyDoc.fullText} />
      </div>
      <div className="mt-12 border-t pt-8 text-sm text-gray-500 space-y-2">
        <p>
          See also: <Link href="/terms" className="text-blue-600 hover:underline">Terms of Service</Link> &middot; <Link href="/health-data" className="text-blue-600 hover:underline">Health Data Consent</Link>
        </p>
      </div>
    </div>
  );
}
