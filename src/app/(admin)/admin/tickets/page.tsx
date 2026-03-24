"use client";

import { useEffect, useState } from "react";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

interface TicketRow {
  id: string;
  email: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
}

export default function AdminTicketsPage() {
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { query, update } = useAdminQuery();

  useEffect(() => {
    async function load() {
      try {
        const data = await query({
          table: "support_tickets",
          order: { column: "created_at", ascending: false },
        });
        setTickets(data || []);
      } catch (err) {
        console.error("Failed to load tickets:", err);
      }
      setLoading(false);
    }
    load();
  }, []);

  async function updateStatus(id: string, newStatus: string) {
    try {
      await update("support_tickets", id, { status: newStatus });
      setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, status: newStatus } : t)));
    } catch (err) {
      console.error("Failed to update ticket:", err);
    }
  }

  if (loading) return <div className="text-gray-500">Loading tickets...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Support Tickets ({tickets.length})</h1>

      <div className="mt-6 space-y-4">
        {tickets.map((ticket) => (
          <div key={ticket.id} className="p-4 bg-white border rounded-lg">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-gray-900">{ticket.subject}</h3>
              <select
                value={ticket.status}
                onChange={(e) => updateStatus(ticket.id, e.target.value)}
                className="text-sm border rounded px-2 py-1"
              >
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <p className="mt-1 text-sm text-gray-500">{ticket.email}</p>
            <p className="mt-2 text-sm text-gray-700">{ticket.body}</p>
            <p className="mt-2 text-xs text-gray-400">
              {new Date(ticket.created_at).toLocaleString()}
            </p>
          </div>
        ))}
        {tickets.length === 0 && <p className="text-gray-500">No support tickets yet.</p>}
      </div>
    </div>
  );
}
