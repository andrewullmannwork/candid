"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";

export default function LandingPage() {
  const { user } = useAuth();

  return (
    <div className="flex flex-col min-h-screen bg-white">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <span className="text-xl font-bold text-blue-600">Candid</span>
        <div className="flex items-center gap-3">
          {user ? (
            <Link
              href="/dashboard"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/auth/signin"
                className="px-4 py-2 text-gray-700 hover:text-gray-900 transition-colors text-sm font-medium"
              >
                Sign In
              </Link>
              <Link
                href="/auth/signup"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
              >
                Join Today
              </Link>
            </>
          )}
        </div>
      </nav>

      {/* Hero — lead with the problem */}
      <section className="flex flex-col items-center justify-center px-6 pt-20 pb-10 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 mb-6 text-sm font-medium text-red-700 bg-red-50 rounded-full border border-red-100">
          ~80% of medical bills contain errors
        </div>
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight text-gray-900 max-w-4xl leading-tight">
          Your medical bills are wrong.
          <br />
          <span className="text-blue-600">We prove it.</span>
        </h1>
        <p className="mt-6 text-xl text-gray-500 max-w-2xl leading-relaxed">
          The average overcharge is $1,300 — and fewer than half of patients ever fight back.
          Candid audits your bills, finds your missed benefits, and arms you with everything you need to dispute.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <Link
            href="/auth/signup"
            className="px-8 py-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-lg font-semibold shadow-lg shadow-blue-600/20"
          >
            Join Today
          </Link>
          <a
            href="#how-it-works"
            className="px-8 py-4 text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors text-lg font-medium"
          >
            See How It Works
          </a>
        </div>
      </section>

      {/* Social proof strip */}
      <section className="px-6 py-12 border-y border-gray-100 bg-gray-50">
        <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
          <div>
            <div className="text-3xl font-bold text-gray-900">~80%</div>
            <div className="mt-1 text-sm text-gray-500">of medical bills contain errors</div>
          </div>
          <div>
            <div className="text-3xl font-bold text-gray-900">$1,300</div>
            <div className="mt-1 text-sm text-gray-500">average overcharge on large bills</div>
          </div>
          <div>
            <div className="text-3xl font-bold text-gray-900">&lt;50%</div>
            <div className="mt-1 text-sm text-gray-500">of patients ever dispute a bill</div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="px-6 py-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-gray-900 text-center mb-4">
            Fight back in three steps
          </h2>
          <p className="text-center text-gray-500 mb-14 max-w-xl mx-auto">
            Upload a bill. Get answers. Take action.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
            <StepCard
              step="01"
              title="Upload your bill"
              description="Snap a photo or upload the PDF. Our AI reads every line — CPT codes, charges, adjustments, all of it."
            />
            <StepCard
              step="02"
              title="Get your audit"
              description="We compare every charge against Medicare benchmarks, flag duplicates, catch balance billing, and surface coding errors."
            />
            <StepCard
              step="03"
              title="Dispute with proof"
              description="Generate ready-to-send dispute letters backed by your audit findings. You send them — we give you the ammo."
            />
          </div>
        </div>
      </section>

      {/* Features — punchy */}
      <section className="px-6 py-20 bg-gray-50">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-gray-900 text-center mb-14">
            Everything you need to stop overpaying
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <FeatureCard
              title="Candid Claim"
              tagline="Find the overcharge."
              description="Upload your bill. We flag overcharges, duplicate charges, unbundled codes, and balance billing — with severity ratings and dollar estimates."
              badge="Free"
            />
            <FeatureCard
              title="Candid Plan"
              tagline="Use what you're paying for."
              description="Your insurance covers more than you think. We surface covered benefits you're leaving on the table — therapy, dietitians, wellness programs, HSA-eligible services."
              badge="Free"
            />
            <FeatureCard
              title="Candid Case"
              tagline="Build your case. Find your lawyer."
              description="Compile your audit, dispute letters, and evidence into a downloadable case file. Need legal help? Browse healthcare billing attorneys — no referral fees."
              badge="Pro"
            />
            <FeatureCard
              title="Candid Care"
              tagline="See what healthcare actually costs."
              description="Compare what you paid against what others paid for the same procedure. Find providers who bill fairly. Powered by real billing data from users like you."
              badge="Coming Soon"
            />
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-6 py-20 text-center">
        <h2 className="text-3xl font-bold text-gray-900 max-w-2xl mx-auto">
          You shouldn&apos;t need a medical degree to read a medical bill.
        </h2>
        <p className="mt-4 text-lg text-gray-500 max-w-xl mx-auto">
          Join Candid and start fighting back.
        </p>
        <Link
          href="/auth/signup"
          className="inline-block mt-8 px-8 py-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-lg font-semibold shadow-lg shadow-blue-600/20"
        >
          Join Today
        </Link>
      </section>

      {/* Footer */}
      <footer className="mt-auto px-6 py-8 border-t border-gray-100 text-center text-sm text-gray-500">
        <div className="flex justify-center gap-6 mb-4">
          <Link href="/privacy" className="hover:text-gray-700">
            Privacy Policy
          </Link>
          <Link href="/terms" className="hover:text-gray-700">
            Terms of Service
          </Link>
          <a href="mailto:support@candid.com" className="hover:text-gray-700">
            Contact
          </a>
        </div>
        <p>&copy; {new Date().getFullYear()} Candid. All rights reserved.</p>
        <p className="mt-1 text-xs text-gray-400">
          Candid is an Airgetlam Labs LLC company.
        </p>
        <p className="mt-1 text-xs text-gray-400">
          Candid is not a healthcare provider, law firm, or insurance company. All outputs are
          informational and do not constitute legal or medical advice.
        </p>
      </footer>
    </div>
  );
}

function StepCard({ step, title, description }: { step: string; title: string; description: string }) {
  return (
    <div className="text-center">
      <div className="inline-flex items-center justify-center w-12 h-12 mb-4 text-sm font-bold text-blue-600 bg-blue-50 rounded-full">
        {step}
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
      <p className="text-gray-500 leading-relaxed">{description}</p>
    </div>
  );
}

function FeatureCard({ title, tagline, description, badge }: { title: string; tagline: string; description: string; badge: string }) {
  const badgeStyles = {
    Free: "bg-green-50 text-green-700 border-green-100",
    Pro: "bg-blue-50 text-blue-700 border-blue-100",
    "Coming Soon": "bg-gray-100 text-gray-500 border-gray-200",
  }[badge] || "bg-gray-100 text-gray-500 border-gray-200";

  return (
    <div className="p-6 bg-white rounded-xl border border-gray-200 hover:border-blue-200 hover:shadow-sm transition-all">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full border ${badgeStyles}`}>
          {badge}
        </span>
      </div>
      <p className="text-sm font-medium text-blue-600 mb-3">{tagline}</p>
      <p className="text-gray-500 leading-relaxed">{description}</p>
    </div>
  );
}
