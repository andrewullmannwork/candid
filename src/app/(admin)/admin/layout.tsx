"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useEffect, useState, type ReactNode } from "react";

const adminNav = [
  { href: "/admin/dashboard", label: "Dashboard", pinned: true },
  { href: "/admin/corrections", label: "Benefit Corrections" },
  { href: "/admin/pipeline", label: "Benefit Pipeline" },
  { href: "/admin/consent", label: "Consent Audit" },
  { href: "/admin/documents/review", label: "Document Review" },
  { href: "/admin/flags", label: "Feature Flags" },
  { href: "/admin/sbc-tickets", label: "SBC Tickets" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/copy", label: "Site Copy" },
  { href: "/admin/subscriptions", label: "Subscriptions" },
  { href: "/admin/tickets", label: "Support Tickets" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/waitlist", label: "Waitlist" },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pwAuthenticated, setPwAuthenticated] = useState(false);
  const [pwChecking, setPwChecking] = useState(true);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSubmitting, setPwSubmitting] = useState(false);

  // Check admin password cookie
  useEffect(() => {
    fetch("/api/auth/admin-password")
      .then((res) => res.json())
      .then(({ authenticated }) => {
        setPwAuthenticated(authenticated);
        setPwChecking(false);
      })
      .catch(() => setPwChecking(false));
  }, []);

  useEffect(() => {
    if (!user || authLoading) return;

    async function checkAdmin() {
      try {
        const idToken = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/auth/admin-check", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (res.ok) {
          const { isAdmin: admin } = await res.json();
          setIsAdmin(admin);
        }
      } catch (err) {
        console.error("Admin check failed:", err);
      }
      setLoading(false);
    }

    checkAdmin();
  }, [user, authLoading]);

  async function handlePwSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPwSubmitting(true);
    setPwError("");
    try {
      const res = await fetch("/api/auth/admin-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwInput }),
      });
      if (res.ok) {
        setPwAuthenticated(true);
        setPwInput("");
      } else {
        setPwError("Invalid password");
      }
    } catch {
      setPwError("Failed to verify password");
    }
    setPwSubmitting(false);
  }

  if (authLoading || loading || pwChecking) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Verifying admin access...</div>
      </div>
    );
  }

  if (!user || !isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Access Denied</h1>
          <p className="mt-2 text-gray-600">You do not have admin privileges.</p>
          <Link href="/dashboard" className="mt-4 inline-block text-blue-600 hover:underline">
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!pwAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="w-full max-w-sm">
          <div className="p-6 bg-white border border-gray-200 rounded-2xl shadow-sm">
            <h2 className="text-lg font-bold text-gray-900 text-center">Admin Access</h2>
            <p className="mt-1 text-sm text-gray-500 text-center">Enter the admin password to continue.</p>
            <form onSubmit={handlePwSubmit} className="mt-5 space-y-3">
              <input
                type="password"
                value={pwInput}
                onChange={(e) => setPwInput(e.target.value)}
                placeholder="Admin password"
                autoFocus
                className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              {pwError && <p className="text-sm text-red-600">{pwError}</p>}
              <button
                type="submit"
                disabled={pwSubmitting || !pwInput}
                className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {pwSubmitting ? "Verifying..." : "Enter"}
              </button>
            </form>
          </div>
          <div className="mt-4 text-center">
            <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-600">
              Back to App
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 bg-gray-900 text-white flex flex-col">
        <div className="p-4 border-b border-gray-700">
          <Link href="/admin/dashboard" className="text-lg font-bold text-blue-400">
            Candid Admin
          </Link>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {adminNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`block px-3 py-2 rounded-lg text-sm ${
                pathname === item.href
                  ? "bg-gray-700 text-white font-medium"
                  : "text-gray-300 hover:bg-gray-800"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-700">
          <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white">
            Back to App
          </Link>
        </div>
      </aside>
      <main className="flex-1 p-8 bg-gray-50">{children}</main>
    </div>
  );
}
