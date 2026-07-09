"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { TurnstileWidget, type TurnstileWidgetHandle } from "@/components/security/TurnstileWidget";
import {
  ADMIN_DASHBOARD,
  ADMIN_NAV_GROUPS,
  adminPageFor,
  type AdminNavGroup,
} from "@/config/admin-nav";

// The sidebar nav (grouped, collapsible) and the per-page ops-manual mapping both
// live in src/config/admin-nav.ts so they can't drift. "Needs action" groups
// default open; read-only/dormant "Monitoring" tools stay collapsed until opened
// (or until the active route lives inside one — NavSection auto-opens its group).

// One collapsible nav group. Local open/closed state seeds from `defaultOpen`
// (or from whether it owns the current route), and force-opens when navigation
// lands on one of its items so the active page is never hidden in a closed group.
function NavSection({ group, pathname }: { group: AdminNavGroup; pathname: string }) {
  const containsActive = group.items.some((item) => pathname === item.href);
  // `null` while the user hasn't toggled this group → the derived open state
  // follows defaultOpen / the active route (so navigating into a collapsed group
  // reveals it). An explicit click pins the user's choice from then on.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? group.defaultOpen ?? containsActive;

  return (
    <div className="pt-3 first:pt-1">
      <button
        type="button"
        onClick={() => setUserToggled(!open)}
        className="group flex w-full items-center justify-between rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 transition-colors hover:text-gray-600"
      >
        <span>{group.label}</span>
        <svg
          className={`h-3.5 w-3.5 text-gray-300 transition-transform group-hover:text-gray-500 ${open ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {open && (
        <div className="mt-1 space-y-0.5">
          {group.items.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative block rounded-lg py-1.5 pl-4 pr-3 text-[13px] transition-colors ${
                  active
                    ? "bg-blue-50 font-medium text-blue-700"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                {active && (
                  <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-blue-600" />
                )}
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Slim context bar atop every admin page: breadcrumb (group / page) on the left,
// a deep-link into this page's ops-manual section on the right. Reads the shared
// registry so it stays correct as pages are added or moved.
function AdminTopBar({ pathname }: { pathname: string }) {
  const page = adminPageFor(pathname);
  const onOpsPage = pathname === "/admin/ops" || pathname.startsWith("/admin/ops/");
  return (
    <div className="flex items-center justify-between border-b border-gray-200 bg-white px-8 py-2.5">
      <div className="flex items-center gap-1.5 text-[13px]">
        {onOpsPage ? (
          <span className="font-medium text-gray-800">Operations Manual</span>
        ) : page ? (
          <>
            {page.group && <span className="text-gray-400">{page.group}</span>}
            {page.group && <span className="text-gray-300">/</span>}
            <span className="font-medium text-gray-800">{page.label}</span>
          </>
        ) : (
          <span className="font-medium text-gray-800">Admin</span>
        )}
      </div>
      {!onOpsPage && page && (
        <Link
          href={`/admin/ops#${page.opsSlug}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1 text-[12px] font-medium text-gray-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
        >
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          Ops
        </Link>
      )}
    </div>
  );
}

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
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

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
        body: JSON.stringify({ password: pwInput, turnstileToken }),
      });
      if (res.ok) {
        setPwAuthenticated(true);
        setPwInput("");
      } else {
        // Surface the server's specific message (invalid / rate-limited / locked /
        // bot-check), then reset Turnstile — its token is single-use, so a retry
        // needs a fresh one.
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setPwError(data.error || "Invalid password");
        turnstileRef.current?.reset();
      }
    } catch {
      setPwError("Failed to verify password");
      turnstileRef.current?.reset();
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
              <TurnstileWidget ref={turnstileRef} action="admin_login" onToken={setTurnstileToken} />
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
    <div className="flex min-h-screen bg-gray-50">
      <aside className="flex w-60 flex-col border-r border-gray-200 bg-white">
        <div className="px-5 py-4">
          <Link href="/admin/dashboard" className="text-[15px] font-semibold tracking-tight">
            <span className="text-blue-600">Candid</span>{" "}
            <span className="text-gray-400">Admin</span>
          </Link>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
          <Link
            href={ADMIN_DASHBOARD.href}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
              pathname === ADMIN_DASHBOARD.href
                ? "bg-blue-600 text-white shadow-sm"
                : "bg-blue-50 text-blue-700 hover:bg-blue-100"
            }`}
          >
            <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            {ADMIN_DASHBOARD.label}
          </Link>
          {ADMIN_NAV_GROUPS.map((group) => (
            <NavSection key={group.label} group={group} pathname={pathname} />
          ))}
        </nav>
        <div className="border-t border-gray-100 px-4 py-3">
          <Link
            href="/dashboard"
            className="flex items-center gap-1.5 text-[13px] text-gray-500 transition-colors hover:text-gray-800"
          >
            <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to App
          </Link>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <AdminTopBar pathname={pathname} />
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
