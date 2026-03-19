import Link from "next/link";
import { CONSENT_DOCUMENTS } from "@/lib/consent/consent-documents";

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
        <pre className="whitespace-pre-wrap font-sans text-base text-gray-700 leading-relaxed">
          {privacyDoc.fullText}
        </pre>
      </div>
    </div>
  );
}
