"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useState, useEffect, type ReactNode } from "react";
import { EmailVerifyBanner } from "@/components/auth/EmailVerifyBanner";
import { ParseCompleteBanner } from "@/components/notifications/ParseCompleteBanner";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useMinHoldLoading } from "@/lib/loading/use-min-hold";
import { DisputeDraftOverlayProvider } from "@/lib/loading/dispute-draft-overlay";

const mainItems = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    href: "/upload",
    label: "Upload",
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
      </svg>
    ),
  },
  {
    href: "/claim",
    label: "Claim",
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    href: "/case",
    label: "Case",
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
      </svg>
    ),
  },
  {
    href: "/care",
    label: "Care",
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
  },
];

const accountItems = [
  {
    href: "/billing",
    label: "Billing",
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    ),
  },
  {
    href: "/profile",
    label: "Profile",
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    ),
  },
  {
    href: "/support",
    label: "Support",
    icon: (
      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, loading, signOut } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close sidebar on route change
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const showCubeLoader = useMinHoldLoading(loading);
  if (showCubeLoader) {
    return <CubeLoaderBuilding className="min-h-screen" />;
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4">
          <p className="text-gray-600">Please sign in to continue.</p>
          <Link
            href="/auth/signin"
            className="inline-block px-6 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold"
          >
            Sign In
          </Link>
        </div>
      </div>
    );
  }

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="px-5 h-16 flex items-center border-b border-gray-100">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-[9px] bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
            </svg>
          </div>
          <span className="text-[15px] font-bold tracking-tight text-gray-900">Candid</span>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {mainItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors ${
                isActive
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-500 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              <span className={isActive ? "text-blue-600" : "text-gray-400"}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
        <div className="px-3 pt-4 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
          Account
        </div>
        {accountItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors ${
                isActive
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-500 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              <span className={isActive ? "text-blue-600" : "text-gray-400"}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className="px-3 py-3 border-t border-gray-100">
        <div className="px-3 py-2">
          <div className="text-xs font-medium text-gray-700 truncate">
            {user.firebaseUser.displayName || user.email}
          </div>
          <div className="text-[11px] text-gray-400 truncate">{user.email}</div>
        </div>
        <button
          onClick={signOut}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Sign out
        </button>
      </div>
    </>
  );

  return (
    <DisputeDraftOverlayProvider>
      <div className="flex min-h-screen bg-gray-50/50">
        {/* Mobile top bar */}
      <div className="fixed top-0 left-0 right-0 z-40 md:hidden bg-white border-b border-gray-100 h-14 flex items-center px-4">
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-1.5 -ml-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-50"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <Link href="/" className="flex items-center gap-2 ml-3">
          <div className="w-6 h-6 rounded-[7px] bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
            </svg>
          </div>
          <span className="text-[14px] font-bold tracking-tight text-gray-900">Candid</span>
        </Link>
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setSidebarOpen(false)}
          />
          {/* Sidebar panel */}
          <aside className="relative w-[220px] h-full bg-white flex flex-col shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-[220px] bg-white border-r border-gray-100 flex-col shrink-0 sticky top-0 h-screen overflow-y-auto">
        {sidebarContent}
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0">
        <div className="max-w-5xl mx-auto px-6 sm:px-8 py-8 pt-20 md:pt-8">
          <EmailVerifyBanner />
          <ParseCompleteBanner />
          {children}
        </div>
      </main>
      </div>
    </DisputeDraftOverlayProvider>
  );
}
