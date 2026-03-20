"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";

export default function LandingPage() {
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleWaitlist(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Something went wrong");
      }

      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col min-h-screen">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b">
        <span className="text-xl font-bold text-blue-600">Candid</span>
        <div className="flex items-center gap-4">
          {user ? (
            <Link
              href="/dashboard"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Dashboard
            </Link>
          ) : (
            <Link
              href="/auth/signin"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Sign In
            </Link>
          )}
        </div>
      </nav>

      {/* Hero */}
      <section className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <h1 className="text-5xl font-bold tracking-tight text-gray-900 max-w-3xl">
          Stop Overpaying for Healthcare
        </h1>
        <p className="mt-6 text-xl text-gray-600 max-w-2xl">
          Candid finds overcharges on your medical bills, uncovers insurance benefits you&apos;re
          missing, and gives you the tools to fight back. Free audit. Free plan check. No surprises.
        </p>

        {/* Waitlist form */}
        {!submitted ? (
          <form onSubmit={handleWaitlist} className="mt-10 flex gap-3 max-w-md w-full">
            <input
              type="email"
              required
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
            >
              {loading ? "..." : "Join Waitlist"}
            </button>
          </form>
        ) : (
          <div className="mt-10 p-4 bg-green-50 border border-green-200 rounded-lg text-green-800">
            You&apos;re on the list! We&apos;ll be in touch.
          </div>
        )}
        {error && <p className="mt-3 text-red-600 text-sm">{error}</p>}
      </section>

      {/* Value Props */}
      <section className="px-6 py-16 bg-gray-50">
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
          <ValueCard
            title="Candid Claim"
            description="Upload your medical bill or EOB. We find overcharges, duplicate charges, and coding errors — flagging exactly where you may have been overcharged."
            badge="Free"
          />
          <ValueCard
            title="Candid Plan"
            description="Discover insurance benefits you're not using — from covered therapy sessions and dietitian visits to HSA-eligible body scans and wellness programs."
            badge="Free"
          />
          <ValueCard
            title="Candid Case"
            description="Need to fight a claim? Generate dispute letters with your evidence, or find healthcare billing attorneys in your area. No referral fees — just specialists."
            badge="Coming Soon"
          />
          <ValueCard
            title="Candid Care"
            description="See what healthcare actually costs — what you paid vs. what others paid, which providers bill fairly, and where to find the best value. Powered by real billing data."
            badge="Coming Soon"
          />
        </div>
      </section>

      {/* Stats */}
      <section className="px-6 py-16">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-gray-900 mb-10">The Problem is Massive</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <StatCard number="~80%" label="of medical bills contain errors" />
            <StatCard number="$1,300" label="average overcharge on large bills" />
            <StatCard number="<50%" label="of eligible patients dispute bills" />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-auto px-6 py-8 border-t text-center text-sm text-gray-500">
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

function ValueCard({ title, description, badge }: { title: string; description: string; badge?: string }) {
  return (
    <div className="p-6 bg-white rounded-xl border">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        {badge && (
          <span className={`text-xs font-medium px-2 py-1 rounded ${
            badge === "Free"
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-500"
          }`}>
            {badge}
          </span>
        )}
      </div>
      <p className="text-gray-600">{description}</p>
    </div>
  );
}

function StatCard({ number, label }: { number: string; label: string }) {
  return (
    <div>
      <div className="text-4xl font-bold text-blue-600">{number}</div>
      <div className="mt-2 text-gray-600">{label}</div>
    </div>
  );
}
