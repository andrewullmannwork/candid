"use client";

import { useEffect, useState } from "react";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

interface WaitlistEntry {
  id: string;
  email: string;
  source: string | null;
  referral_code: string | null;
  created_at: string;
}

export default function AdminWaitlistPage() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { query } = useAdminQuery();

  useEffect(() => {
    async function load() {
      try {
        const data = await query({
          table: "waitlist",
          order: { column: "created_at", ascending: false },
        });
        setEntries(data || []);
      } catch (err) {
        console.error("Failed to load waitlist:", err);
      }
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="text-gray-500">Loading waitlist...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Waitlist ({entries.length})</h1>
      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="pb-2 pr-4">Email</th>
              <th className="pb-2 pr-4">Source</th>
              <th className="pb-2 pr-4">Referral</th>
              <th className="pb-2">Signed Up</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b">
                <td className="py-2 pr-4">{entry.email}</td>
                <td className="py-2 pr-4 text-gray-500">{entry.source || "—"}</td>
                <td className="py-2 pr-4 text-gray-500">{entry.referral_code || "—"}</td>
                <td className="py-2 text-gray-500">
                  {new Date(entry.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && (
          <p className="mt-4 text-gray-500">No waitlist signups yet.</p>
        )}
      </div>
    </div>
  );
}
