"use client";

import { useEffect, useState } from "react";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

interface ConsentRow {
  id: string;
  user_id: string | null;
  email: string | null;
  consent_type: string;
  consent_version: string;
  granted: boolean;
  created_at: string;
}

export default function AdminConsentPage() {
  const [events, setEvents] = useState<ConsentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { query } = useAdminQuery();

  useEffect(() => {
    async function load() {
      try {
        const data = await query({
          table: "consent_events",
          order: { column: "created_at", ascending: false },
          limit: 200,
        });
        setEvents(data || []);
      } catch (err) {
        console.error("Failed to load consent events:", err);
      }
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="text-gray-500">Loading consent audit trail...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Consent Audit Trail</h1>
      <p className="mt-1 text-sm text-gray-500">
        Immutable record. These events cannot be modified or deleted.
      </p>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="pb-2 pr-4">User / Email</th>
              <th className="pb-2 pr-4">Type</th>
              <th className="pb-2 pr-4">Version</th>
              <th className="pb-2 pr-4">Granted</th>
              <th className="pb-2">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-b">
                <td className="py-2 pr-4 text-gray-600">
                  {e.user_id ? e.user_id.slice(0, 8) + "..." : e.email || "—"}
                </td>
                <td className="py-2 pr-4">{e.consent_type}</td>
                <td className="py-2 pr-4 text-gray-500">v{e.consent_version}</td>
                <td className="py-2 pr-4">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs ${
                      e.granted ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {e.granted ? "Granted" : "Revoked"}
                  </span>
                </td>
                <td className="py-2 text-gray-500">
                  {new Date(e.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 && <p className="mt-4 text-gray-500">No consent events recorded.</p>}
      </div>
    </div>
  );
}
