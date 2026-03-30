"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";

export default function LandingPage() {
  const { user } = useAuth();

  return (
    <div className="flex flex-col min-h-screen bg-white">

      {/* ── Navigation ───────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-gray-100/80">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-5 sm:px-8 h-16">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center shadow-sm">
              <svg className="w-4.5 h-4.5 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <span className="text-[17px] font-bold tracking-tight text-gray-900">Candid</span>
          </Link>
          <div className="flex items-center gap-2">
            {user ? (
              <Link href="/dashboard" className="px-4 py-2 bg-gray-900 text-white rounded-xl text-sm font-semibold hover:bg-gray-800 transition-colors">
                Dashboard
              </Link>
            ) : (
              <>
                <Link href="/auth/signin" className="hidden sm:inline-flex px-3.5 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">
                  Sign in
                </Link>
                <Link href="/auth/signup" className="px-4 py-2 bg-gray-900 text-white rounded-xl text-sm font-semibold hover:bg-gray-800 transition-colors">
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="gradient-mesh absolute inset-0" />
        <div className="relative max-w-5xl mx-auto px-5 sm:px-8 pt-20 sm:pt-32 pb-20 sm:pb-28">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 mb-8 text-xs font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-100">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              Free bill audit — no credit card required
            </div>

            <h1 className="text-[42px] sm:text-6xl md:text-[68px] font-bold tracking-[-0.02em] leading-[1.05] text-gray-900">
              Healthcare should
              <span className="block">make you healthy,</span>
              <span className="block text-blue-600">not broke.</span>
            </h1>

            <p className="mt-6 sm:mt-7 text-lg sm:text-xl text-gray-500 leading-relaxed max-w-xl">
              Find out if you were overcharged. Find out what your insurance actually covers.
            </p>

            <div className="mt-9 flex flex-col sm:flex-row gap-3">
              <Link
                href="/auth/signup"
                className="group inline-flex items-center justify-center gap-2 px-6 py-3.5 bg-blue-600 text-white rounded-2xl text-[15px] font-semibold hover:bg-blue-700 transition-all glow-blue hover:-translate-y-0.5"
              >
                Sign up — it&apos;s free
                <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
              <a
                href="#what-you-get"
                className="inline-flex items-center justify-center px-6 py-3.5 text-gray-700 border border-gray-200 rounded-2xl text-[15px] font-medium hover:bg-gray-50 hover:border-gray-300 transition-all"
              >
                See what you get
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats ────────────────────────────────────────────────────────────── */}
      <section className="border-y border-gray-100">
        <div className="max-w-5xl mx-auto px-5 sm:px-8 py-12 sm:py-14">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-0 sm:divide-x divide-gray-150">
            <StatCard
              value="3 in 4"
              label="medical bills contain errors"
              source="Medical Billing Advocates of America"
              num={1}
            />
            <StatCard
              value="$1,300"
              label="average overcharge on large bills"
              source="NerdWallet / MBAA billing analysis"
              num={2}
            />
            <StatCard
              value="92%"
              label="of covered preventive benefits go unused"
              source="CDC preventive services utilization data"
              num={3}
            />
          </div>
        </div>
      </section>

      {/* ── Two Pillars ──────────────────────────────────────────────────────── */}
      <section id="what-you-get" className="max-w-5xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
        <div className="text-center mb-14 sm:mb-16">
          <p className="text-xs font-bold text-blue-600 uppercase tracking-[0.15em] mb-3">Two ways we save you money</p>
          <h2 className="text-3xl sm:text-[42px] font-bold tracking-tight text-gray-900 leading-tight">
            Find overcharges.<br />Discover missed benefits.
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Pillar 1: Audit */}
          <div className="relative group rounded-3xl border border-gray-200 bg-gradient-to-b from-white to-gray-50/80 p-7 sm:p-9 hover:border-blue-200 hover:shadow-lg hover:shadow-blue-600/5 transition-all">
            <div className="w-12 h-12 rounded-2xl bg-red-50 flex items-center justify-center mb-5">
              <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-gray-900 mb-2">Audit your bills</h3>
            <p className="text-[15px] text-gray-500 leading-relaxed mb-6">
              Upload your bill. We flag overcharges, duplicate codes,
              unbundled procedures, and balance billing — each with a severity rating
              and dollar estimate. Then we draft the dispute letter for you.
            </p>
            <ul className="space-y-2.5">
              <CheckItem>Compare every charge against Candid benchmarks</CheckItem>
              <CheckItem>Catch duplicate, unbundled, and upcoded charges</CheckItem>
              <CheckItem>Generate ready-to-send dispute letters</CheckItem>
              <CheckItem>Build a full case file with evidence</CheckItem>
            </ul>
            <div className="mt-6 pt-5 border-t border-gray-100">
              <span className="text-xs font-semibold text-green-700 bg-green-50 px-2.5 py-1 rounded-full">Free to start</span>
            </div>
          </div>

          {/* Pillar 2: Benefits */}
          <div className="relative group rounded-3xl border border-gray-200 bg-gradient-to-b from-white to-gray-50/80 p-7 sm:p-9 hover:border-blue-200 hover:shadow-lg hover:shadow-blue-600/5 transition-all">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center mb-5">
              <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-gray-900 mb-2">Discover your benefits</h3>
            <p className="text-[15px] text-gray-500 leading-relaxed mb-6">
              Your plan covers more than you think. Candid reads your policy and shows
              covered benefits you&apos;re leaving on the table — from preventive screenings
              to physical therapy.
            </p>
            <ul className="space-y-2.5">
              <CheckItem>35+ commonly missed benefits analyzed</CheckItem>
              <CheckItem>Copays, in-network providers, and coverage details in plain English</CheckItem>
              <CheckItem>HSA/FSA eligibility flagged automatically</CheckItem>
              <CheckItem>Personalized to your insurer, state, and demographics</CheckItem>
            </ul>
            <div className="mt-6 pt-5 border-t border-gray-100">
              <span className="text-xs font-semibold text-green-700 bg-green-50 px-2.5 py-1 rounded-full">Free</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── How It Works ─────────────────────────────────────────────────────── */}
      <section className="bg-gray-50 border-y border-gray-100">
        <div className="max-w-5xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
          <div className="text-center mb-14 sm:mb-16">
            <p className="text-xs font-bold text-blue-600 uppercase tracking-[0.15em] mb-3">How it works</p>
            <h2 className="text-3xl sm:text-[42px] font-bold tracking-tight text-gray-900">
              Three steps. Real answers.
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8">
            <ProcessStep
              num="01"
              title="Upload your documents"
              desc="Snap a photo of your insurance card and upload your bills. We scan everything automatically to fill in your plan details."
            />
            <ProcessStep
              num="02"
              title="Get your audit + benefit information"
              desc="We compare every charge to benchmarks, flag errors, and surface covered benefits you're leaving on the table — in seconds."
            />
            <ProcessStep
              num="03"
              title="Take action"
              desc="Dispute letters, case files, benefit guides — everything you need to fight overcharges and get the most out of your plan. You stay in control."
            />
          </div>
        </div>
      </section>

      {/* ── Full Product Grid ────────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
        <div className="text-center mb-14 sm:mb-16">
          <p className="text-xs font-bold text-blue-600 uppercase tracking-[0.15em] mb-3">The Candid suite</p>
          <h2 className="text-3xl sm:text-[42px] font-bold tracking-tight text-gray-900">
            Everything to stop overpaying
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ProductCard
            title="Candid Claim"
            tagline="Find overcharges on your bills."
            desc="Upload a bill or EOB. We flag overcharges, duplicates, unbundled codes, and balance billing - showing you the severity and estimated dollar amounts."
            tag="Free"
            tagColor="green"
          />
          <ProductCard
            title="Candid Plan"
            tagline="Use what you're already paying for."
            desc="See every benefit your insurance covers that you're not using — therapy, acupuncture, chiropractic, nutritionists, gym reimbursements, HSA-eligible services, and more."
            tag="Free"
            tagColor="green"
          />
          <ProductCard
            title="Candid Case"
            tagline="Build your case. Find your lawyer."
            desc="Compile your audit, dispute letters, and evidence into a downloadable case file. Browse healthcare billing attorneys if you need legal help — no referral fees."
            tag="Pro"
            tagColor="blue"
          />
          <ProductCard
            title="Candid Care"
            tagline="Compare costs. Find fair providers."
            desc="Compare your procedure costs with other Candid users. Find providers who bill fairly. Built on real, anonymized billing data from users like you."
            tag="Coming Soon"
            tagColor="gray"
          />
        </div>
      </section>

      {/* ── Trust Section ────────────────────────────────────────────────────── */}
      <section className="bg-gray-950 text-white">
        <div className="max-w-5xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
          <div className="text-center mb-14">
            <p className="text-xs font-bold text-blue-400 uppercase tracking-[0.15em] mb-3">Built on trust</p>
            <h2 className="text-3xl sm:text-[42px] font-bold tracking-tight">
              Your data is yours. Period.
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <TrustCard
              title="HIPAA-aware by design"
              desc="Documents encrypted at rest and in transit. We never sell your personal health information. Ever."
              icon={<LockIcon />}
            />
            <TrustCard
              title="Explicit consent only"
              desc="We ask before touching your data. Every consent event is logged and auditable. Revoke anytime with one click."
              icon={<ShieldIcon />}
            />
            <TrustCard
              title="You send the letters"
              desc="Candid gives you the information and tools. You decide what to do with them. No attorney-client relationship."
              icon={<BalanceIcon />}
            />
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-600 via-blue-600 to-blue-700" />
        <div className="absolute inset-0 opacity-[0.04]" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
          backgroundSize: "24px 24px",
        }} />
        <div className="relative max-w-3xl mx-auto px-5 sm:px-8 py-20 sm:py-28 text-center text-white">
          <h2 className="text-3xl sm:text-5xl font-bold tracking-tight leading-tight">
            You shouldn&apos;t need a medical degree to read a medical bill.
          </h2>
          <p className="mt-5 text-base sm:text-lg text-blue-100 max-w-lg mx-auto leading-relaxed">
            See what you were charged, what you were owed, and the benefits you&apos;re not using.
          </p>
          <Link
            href="/auth/signup"
            className="group inline-flex items-center gap-2 mt-9 px-7 py-3.5 bg-white text-blue-700 rounded-2xl text-[15px] font-bold hover:bg-blue-50 transition-all shadow-xl hover:-translate-y-0.5"
          >
            Get started free
            <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
          <p className="mt-3 text-xs text-blue-200">No credit card required. Cancel anytime.</p>
        </div>
      </section>

      {/* ── Sources ──────────────────────────────────────────────────────────── */}
      <section className="border-t border-gray-100 bg-gray-50/50">
        <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Sources</p>
          <ol className="text-[11px] text-gray-400 leading-relaxed space-y-1 list-decimal list-inside">
            <li>Medical Billing Advocates of America — billing error rate data. Referenced via{" "}
              <a href="https://www.healthline.com/health-news/80-percent-hospital-bills-have-errors-are-you-being-overcharged"
                className="underline hover:text-gray-600" target="_blank" rel="noopener noreferrer">
                Healthline
              </a>
            </li>
            <li>NerdWallet analysis of medical billing advocate data — average overcharge on hospital bills exceeding $10,000. Referenced via{" "}
              <a href="https://orbdoc.com/blog/medical-bill-errors-80-percent-problem"
                className="underline hover:text-gray-600" target="_blank" rel="noopener noreferrer">
                Orbdoc
              </a>
            </li>
            <li>CDC National Center for Health Statistics — preventive services utilization. Only 8% of U.S. adults receive all recommended preventive services. Referenced via{" "}
              <a href="https://www.lavidge.com/industries/healthcare/are-your-patients-benefits-going-unused/"
                className="underline hover:text-gray-600" target="_blank" rel="noopener noreferrer">
                Lavidge
              </a>
            </li>
          </ol>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <footer className="border-t border-gray-100">
        <div className="max-w-5xl mx-auto px-5 sm:px-8 py-10">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
            <div>
              <div className="flex items-center gap-2.5 mb-2">
                <div className="w-7 h-7 rounded-[9px] bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center">
                  <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
                  </svg>
                </div>
                <span className="text-sm font-bold text-gray-900">Candid</span>
              </div>
              <p className="text-xs text-gray-400">An Airgetlam Labs LLC company.</p>
            </div>
            <div className="flex items-center gap-6 text-xs text-gray-400">
              <Link href="/privacy" className="hover:text-gray-700 transition-colors">Privacy</Link>
              <Link href="/terms" className="hover:text-gray-700 transition-colors">Terms</Link>
              <Link href="/health-data" className="hover:text-gray-700 transition-colors">Consumer Health Data Privacy Policy</Link>
              <Link href="/support" className="hover:text-gray-700 transition-colors">Support</Link>
            </div>
          </div>
          <p className="mt-6 text-[11px] text-gray-400 leading-relaxed max-w-2xl">
            Candid is not a healthcare provider, law firm, or insurance company. All outputs are informational
            and do not constitute legal, medical, or financial advice. Always consult a qualified professional.
            &copy; {new Date().getFullYear()} Airgetlam Labs LLC. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ value, label, source, num }: { value: string; label: string; source: string; num: number }) {
  return (
    <div className="sm:px-8 text-center">
      <div className="text-3xl sm:text-4xl font-bold text-gray-900 tabular-nums tracking-tight">{value}</div>
      <div className="mt-1 text-sm text-gray-500">{label}</div>
      <div className="mt-1.5 text-[10px] text-gray-400">
        <sup>{num}</sup> {source}
      </div>
    </div>
  );
}

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm text-gray-600">
      <svg className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
      </svg>
      {children}
    </li>
  );
}

function ProcessStep({ num, title, desc }: { num: string; title: string; desc: string }) {
  return (
    <div className="relative bg-white rounded-3xl border border-gray-200 p-7 sm:p-8">
      <span className="text-[11px] font-bold text-blue-500 uppercase tracking-[0.15em] mb-4 block">{num}</span>
      <h3 className="text-lg font-bold text-gray-900 mb-2.5">{title}</h3>
      <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
    </div>
  );
}

function ProductCard({
  title,
  tagline,
  desc,
  tag,
  tagColor,
}: {
  title: string;
  tagline: string;
  desc: string;
  tag: string;
  tagColor: "green" | "blue" | "gray";
}) {
  const tagClass = {
    green: "bg-green-50 text-green-700 border-green-100",
    blue: "bg-blue-50 text-blue-700 border-blue-100",
    gray: "bg-gray-100 text-gray-500 border-gray-200",
  }[tagColor];

  return (
    <div className="group rounded-2xl border border-gray-200 bg-white p-6 sm:p-7 hover:border-gray-300 hover:shadow-md hover:shadow-gray-900/5 transition-all">
      <div className="flex items-start justify-between mb-1">
        <h3 className="text-base font-bold text-gray-900">{title}</h3>
        <span className={`shrink-0 ml-3 text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${tagClass}`}>{tag}</span>
      </div>
      <p className="text-sm font-medium text-blue-600 mb-3">{tagline}</p>
      <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
    </div>
  );
}

function TrustCard({ title, desc, icon }: { title: string; desc: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white/[0.04] border border-white/[0.08] p-6 sm:p-7">
      <div className="w-10 h-10 rounded-xl bg-white/[0.06] flex items-center justify-center mb-5">
        {icon}
      </div>
      <h3 className="text-[15px] font-semibold text-white mb-2">{title}</h3>
      <p className="text-sm text-gray-400 leading-relaxed">{desc}</p>
    </div>
  );
}

function LockIcon() {
  return (
    <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  );
}

function BalanceIcon() {
  return (
    <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
    </svg>
  );
}
