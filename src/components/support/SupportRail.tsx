"use client";

interface Props {
  faqEnabled: boolean;
}

const FAQ_ENTRIES = [
  "How long does a bill audit usually take?",
  "Can I dispute a charge without a lawyer?",
  "What documents do you need to verify my plan?",
  "Is my data shared with my insurance company?",
];

export default function SupportRail({ faqEnabled }: Props) {
  return (
    <aside className="space-y-4">
      {/* Reply time card */}
      <div className="p-5 border border-gray-200 rounded-2xl bg-white">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
            <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <div className="text-lg font-bold text-gray-900">~ 24 hours</div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Typical reply time</div>
          </div>
        </div>
        <p className="mt-3 text-sm text-gray-700">
          You&apos;ll hear from <strong>a real human</strong> on the Candid team — not a bot, not an offshore queue. We reply by email.
        </p>
      </div>

      {/* FAQ card — flag-gated OFF for MVP per D-§1.B.3-B */}
      {faqEnabled && (
        <div className="p-5 border border-gray-200 rounded-2xl bg-white">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Common questions
          </div>
          <div className="space-y-2">
            {FAQ_ENTRIES.map((q) => (
              <button
                key={q}
                type="button"
                className="w-full flex items-center justify-between text-left p-3 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <span className="text-sm text-gray-700">{q}</span>
                <svg width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" className="text-gray-400">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Trust card — NO HIPAA reference per D-§1.B.3-C NON-NEGOTIABLE */}
      <div className="p-5 border border-gray-200 rounded-2xl bg-white">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Your data
        </div>
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center flex-shrink-0">
              <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold text-gray-900">Encrypted in transit and at rest</div>
              <p className="text-xs text-gray-600 mt-0.5">Tickets and attachments are protected with TLS in transit and AES-256 at rest.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center flex-shrink-0">
              <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12l2 2 4-4m5.6-4A11.9 11.9 0 0112 2.9 11.9 11.9 0 013.4 6 12 12 0 003 9c0 5.6 3.8 10.3 9 11.6 5.2-1.3 9-6 9-11.6 0-1-.1-2-.4-3z"
                />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold text-gray-900">Never sold, never shared</div>
              <p className="text-xs text-gray-600 mt-0.5">We don&apos;t share what you tell us with insurers, providers, or marketers. Period.</p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
