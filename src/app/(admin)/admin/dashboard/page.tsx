"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";

interface Section {
  key: string;
  title: string;
  count: number;
  href: string;
  description: string;
  items: Array<Record<string, unknown>>;
}

export default function AdminDashboardPage() {
  const { user } = useAuth();
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/admin/dashboard", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok && !cancelled) {
          const data = await res.json();
          setSections(data.sections || []);
        }
      } catch (err) {
        console.error("Failed to load admin dashboard:", err);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user]);

  const totalPending = sections.reduce((sum, s) => sum + s.count, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">To-Do Center</h1>
        <p className="mt-1 text-sm text-gray-500">
          {totalPending === 0
            ? "All caught up. Nothing waiting across any tab."
            : `${totalPending} item${totalPending === 1 ? "" : "s"} across ${sections.filter((s) => s.count > 0).length} section${sections.filter((s) => s.count > 0).length === 1 ? "" : "s"} waiting for action.`}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {sections.map((section) => (
          <SectionCard key={section.key} section={section} />
        ))}
      </div>
    </div>
  );
}

function SectionCard({ section }: { section: Section }) {
  const hasItems = section.count > 0;
  return (
    <Link
      href={section.href}
      className="group block rounded-xl border border-gray-200 bg-white p-5 transition-all hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900">{section.title}</h2>
          <p className="mt-1 text-xs text-gray-500 line-clamp-2">{section.description}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${
            hasItems
              ? "bg-amber-100 text-amber-800"
              : "bg-green-100 text-green-800"
          }`}
        >
          {section.count}
        </span>
      </div>

      {hasItems && section.items.length > 0 && (
        <div className="mt-4 border-t border-gray-100 pt-3 space-y-1.5">
          {section.items.slice(0, 5).map((item, i) => (
            <div key={i} className="text-xs text-gray-600 truncate">
              {renderItemPreview(section.key, item)}
            </div>
          ))}
          {section.count > section.items.length && (
            <p className="text-[11px] text-gray-400">
              + {section.count - section.items.length} more
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center justify-end text-xs font-semibold text-blue-600 transition-colors group-hover:text-blue-700">
        Open
        <svg className="ml-1 h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  );
}

function renderItemPreview(sectionKey: string, item: Record<string, unknown>): string {
  switch (sectionKey) {
    case "corrections":
      return `${item.service_slug || "—"} · ${item.field || "field"} → ${item.proposed_value || "?"}`;
    case "documents_review":
      return `${item.file_name || item.id || "document"} · ${item.status || "?"}`;
    case "support":
      return `${item.subject || "(no subject)"} · ${item.status || "open"}`;
    case "disputes_missing_plan":
      return `${item.disputeType || "dispute"} · needs ${item.needsPlanForYear || "?"} plan`;
    default:
      return String(item.id || "item");
  }
}
