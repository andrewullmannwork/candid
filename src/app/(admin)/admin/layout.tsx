"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useEffect, useState, type ReactNode } from "react";

const adminNav = [
  { href: "/admin/waitlist", label: "Waitlist" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/documents", label: "Documents" },
  { href: "/admin/consent", label: "Consent Audit" },
  { href: "/admin/tickets", label: "Support Tickets" },
  { href: "/admin/copy", label: "Site Copy" },
  { href: "/admin/subscriptions", label: "Subscriptions" },
  { href: "/admin/pipeline", label: "Benefit Pipeline" },
  { href: "/admin/sbc-tickets", label: "SBC Tickets" },
  { href: "/admin/settings", label: "Settings" },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

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

  if (authLoading || loading) {
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

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 bg-gray-900 text-white flex flex-col">
        <div className="p-4 border-b border-gray-700">
          <Link href="/admin/waitlist" className="text-lg font-bold text-blue-400">
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
