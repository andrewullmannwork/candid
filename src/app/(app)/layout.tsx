"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import type { ReactNode } from "react";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/upload", label: "Upload" },
  { href: "/audit", label: "Audit Results" },
  { href: "/disputes", label: "Dispute Letters" },
  { href: "/profile", label: "Profile" },
  { href: "/billing", label: "Billing" },
  { href: "/support", label: "Support" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, loading, signOut } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4">
          <p className="text-gray-600">Please sign in to continue.</p>
          <Link
            href="/auth/signin"
            className="inline-block px-6 py-2 bg-blue-600 text-white rounded-lg"
          >
            Sign In
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-50 border-r flex flex-col">
        <div className="p-4 border-b">
          <Link href="/" className="text-lg font-bold text-blue-600">
            Candid
          </Link>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`block px-3 py-2 rounded-lg text-sm ${
                pathname === item.href
                  ? "bg-blue-50 text-blue-700 font-medium"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-3 border-t">
          <div className="text-xs text-gray-500 mb-2 truncate">{user.email}</div>
          <button
            onClick={signOut}
            className="w-full px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg text-left"
          >
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
