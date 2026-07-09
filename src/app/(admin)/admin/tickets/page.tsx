"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

interface TicketRow {
  id: string;
  email: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
  // mig 117 — set when the ticket is posted to #support; drives "Open in Slack".
  slack_thread_ts: string | null;
}

type StatusFilter = "open" | "in_progress" | "resolved" | "closed" | "all";
const STATUS_TABS: StatusFilter[] = ["open", "in_progress", "resolved", "closed", "all"];

export default function AdminTicketsPage() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [linkBusyId, setLinkBusyId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
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
    // Mount-only: useAdminQuery's `query` is a fresh closure each render; adding
    // it would refetch on every render. Intentional one-shot load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function updateStatus(id: string, newStatus: string) {
    try {
      await update("support_tickets", id, { status: newStatus });
      setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, status: newStatus } : t)));
    } catch (err) {
      console.error("Failed to update ticket:", err);
    }
  }

  // Andrew smoke-test #5: replies happen in the ticket's Slack thread (which
  // emails the user via Resend). Jump straight there — the endpoint resolves the
  // stored slack_thread_ts to a Slack permalink.
  async function openInSlack(ticketId: string) {
    if (!user) return;
    setLinkError(null);
    setLinkBusyId(ticketId);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/admin/tickets/slack-link?ticketId=${ticketId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { permalink?: string; error?: string };
      if (res.ok && data.permalink) {
        window.open(data.permalink, "_blank", "noopener,noreferrer");
      } else {
        setLinkError(data.error ?? "Couldn't open the Slack thread.");
      }
    } catch {
      setLinkError("Couldn't open the Slack thread (network error).");
    } finally {
      setLinkBusyId(null);
    }
  }

  if (loading) return <div className="text-gray-500">Loading tickets...</div>;

  const visible =
    statusFilter === "all" ? tickets : tickets.filter((t) => t.status === statusFilter);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Support Tickets ({tickets.length})</h1>

      {/* Status filter */}
      <div className="mt-4 flex flex-wrap gap-2">
        {STATUS_TABS.map((s) => {
          const count = s === "all" ? tickets.length : tickets.filter((t) => t.status === s).length;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                statusFilter === s ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {s.replace("_", " ")} ({count})
            </button>
          );
        })}
      </div>

      {linkError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {linkError}
        </div>
      )}

      <div className="mt-6 space-y-4">
        {visible.map((ticket) => (
          <div key={ticket.id} className="p-4 bg-white border rounded-lg">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-medium text-gray-900">{ticket.subject}</h3>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => openInSlack(ticket.id)}
                  disabled={!ticket.slack_thread_ts || linkBusyId === ticket.id}
                  title={
                    ticket.slack_thread_ts
                      ? "Open the Slack thread — reply there to email the user via Resend"
                      : "No Slack thread linked to this ticket"
                  }
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {linkBusyId === ticket.id ? "Opening…" : "Open in Slack ↗"}
                </button>
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
            </div>
            <p className="mt-1 text-sm text-gray-500">{ticket.email}</p>
            <p className="mt-2 text-sm text-gray-700">{ticket.body}</p>
            <p className="mt-2 text-xs text-gray-400">
              {new Date(ticket.created_at).toLocaleString()}
            </p>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="text-gray-500">
            {statusFilter === "all"
              ? "No support tickets yet."
              : `No ${statusFilter.replace("_", " ")} tickets.`}
          </p>
        )}
      </div>
    </div>
  );
}
