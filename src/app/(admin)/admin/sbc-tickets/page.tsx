"use client";

import { useEffect, useState } from "react";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

interface SbcTicket {
  id: string;
  tier: number;
  status: string;
  insurer_name: string;
  plan_name: string | null;
  hios_id: string | null;
  state: string | null;
  market: string | null;
  contact_method: string | null;
  contact_number: string | null;
  assigned_to: string | null;
  attempts: number;
  max_attempts: number;
  escalation_stage: number;
  notes: Array<{ date: string; text: string; agent: string }>;
  reference_number: string | null;
  follow_up_date: string | null;
  resolved_plan_id: string | null;
  created_at: string;
  updated_at: string;
}

const TIER_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: "User Request", color: "bg-red-100 text-red-700" },
  2: { label: "Known Gap", color: "bg-amber-100 text-amber-700" },
  3: { label: "Stale", color: "bg-gray-100 text-gray-600" },
  4: { label: "Sweep", color: "bg-blue-100 text-blue-600" },
};

const STATUS_OPTIONS = [
  "pending",
  "in_progress",
  "awaiting_response",
  "received",
  "failed",
  "escalated",
];

export default function AdminSbcTicketsPage() {
  const [tickets, setTickets] = useState<SbcTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterTier, setFilterTier] = useState<string>("all");
  const [noteModal, setNoteModal] = useState<{ ticketId: string; notes: SbcTicket["notes"] } | null>(null);
  const [newNote, setNewNote] = useState("");
  const { query, update } = useAdminQuery();

  async function loadTickets() {
    try {
      const data = await query({
        table: "sbc_tickets",
        order: { column: "tier", ascending: true },
      });
      setTickets(data || []);
    } catch (err) {
      console.error("Failed to load SBC tickets:", err);
    }
    setLoading(false);
  }

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    loadTickets();
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function updateStatus(id: string, newStatus: string) {
    try {
      await update("sbc_tickets", id, { status: newStatus, updated_at: new Date().toISOString() });
      setTickets((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: newStatus, updated_at: new Date().toISOString() } : t))
      );
    } catch (err) {
      console.error("Failed to update SBC ticket:", err);
    }
  }

  async function addNote(ticketId: string) {
    if (!newNote.trim()) return;
    const ticket = tickets.find((t) => t.id === ticketId);
    if (!ticket) return;

    const updatedNotes = [
      ...(ticket.notes || []),
      { date: new Date().toISOString(), text: newNote.trim(), agent: "admin" },
    ];

    try {
      await update("sbc_tickets", ticketId, { notes: updatedNotes, updated_at: new Date().toISOString() });
      setTickets((prev) =>
        prev.map((t) => (t.id === ticketId ? { ...t, notes: updatedNotes, updated_at: new Date().toISOString() } : t))
      );
      setNoteModal({ ticketId, notes: updatedNotes });
      setNewNote("");
    } catch (err) {
      console.error("Failed to add note:", err);
    }
  }

  async function incrementAttempts(id: string) {
    const ticket = tickets.find((t) => t.id === id);
    if (!ticket) return;
    const newAttempts = ticket.attempts + 1;
    const updates: Record<string, unknown> = { attempts: newAttempts, updated_at: new Date().toISOString() };
    if (newAttempts >= ticket.max_attempts) {
      updates.status = "escalated";
      updates.escalation_stage = Math.min(ticket.escalation_stage + 1, 4);
    }
    try {
      await update("sbc_tickets", id, updates);
      setTickets((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...updates } as SbcTicket : t))
      );
    } catch (err) {
      console.error("Failed to increment attempts:", err);
    }
  }

  const filtered = tickets.filter((t) => {
    if (filterStatus !== "all" && t.status !== filterStatus) return false;
    if (filterTier !== "all" && t.tier !== Number(filterTier)) return false;
    return true;
  });

  const statusCounts = tickets.reduce(
    (acc, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  if (loading) return <div className="text-gray-500">Loading SBC tickets...</div>;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">SBC Ticket Queue ({tickets.length})</h1>
      </div>

      {/* Status summary bar */}
      <div className="mt-4 flex flex-wrap gap-3">
        {STATUS_OPTIONS.map((s) => (
          <div
            key={s}
            className={`px-3 py-1 rounded-full text-xs font-medium cursor-pointer transition-colors ${
              filterStatus === s ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
            onClick={() => setFilterStatus(filterStatus === s ? "all" : s)}
          >
            {s.replace("_", " ")} ({statusCounts[s] || 0})
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="mt-4 flex gap-4">
        <select
          value={filterTier}
          onChange={(e) => setFilterTier(e.target.value)}
          className="text-sm border rounded px-3 py-1.5"
        >
          <option value="all">All tiers</option>
          <option value="1">Tier 1 — User Request</option>
          <option value="2">Tier 2 — Known Gap</option>
          <option value="3">Tier 3 — Stale</option>
          <option value="4">Tier 4 — Sweep</option>
        </select>
      </div>

      {/* Ticket table */}
      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="pb-2 pr-4 font-medium">Tier</th>
              <th className="pb-2 pr-4 font-medium">Insurer / Plan</th>
              <th className="pb-2 pr-4 font-medium">State</th>
              <th className="pb-2 pr-4 font-medium">Market</th>
              <th className="pb-2 pr-4 font-medium">Attempts</th>
              <th className="pb-2 pr-4 font-medium">Status</th>
              <th className="pb-2 pr-4 font-medium">Follow-up</th>
              <th className="pb-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((ticket) => {
              const tier = TIER_LABELS[ticket.tier] || { label: `T${ticket.tier}`, color: "bg-gray-100 text-gray-600" };
              return (
                <tr key={ticket.id} className="border-b hover:bg-gray-50">
                  <td className="py-3 pr-4">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${tier.color}`}>
                      {tier.label}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="font-medium text-gray-900">{ticket.insurer_name}</div>
                    {ticket.plan_name && (
                      <div className="text-xs text-gray-500">{ticket.plan_name}</div>
                    )}
                    {ticket.hios_id && (
                      <div className="text-xs text-gray-400">HIOS: {ticket.hios_id}</div>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-gray-600">{ticket.state || "—"}</td>
                  <td className="py-3 pr-4 text-gray-600">{ticket.market || "—"}</td>
                  <td className="py-3 pr-4">
                    <span className={ticket.attempts >= ticket.max_attempts ? "text-red-600 font-medium" : "text-gray-600"}>
                      {ticket.attempts}/{ticket.max_attempts}
                    </span>
                    {ticket.escalation_stage > 0 && (
                      <span className="ml-1 text-xs text-orange-500">E{ticket.escalation_stage}</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <select
                      value={ticket.status}
                      onChange={(e) => updateStatus(ticket.id, e.target.value)}
                      className="text-xs border rounded px-2 py-1"
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s.replace("_", " ")}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 pr-4 text-xs text-gray-500">
                    {ticket.follow_up_date
                      ? new Date(ticket.follow_up_date).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => incrementAttempts(ticket.id)}
                        className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                        title="Log an attempt (auto-escalates at max)"
                      >
                        +Attempt
                      </button>
                      <button
                        onClick={() => setNoteModal({ ticketId: ticket.id, notes: ticket.notes || [] })}
                        className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                      >
                        Notes {ticket.notes?.length ? `(${ticket.notes.length})` : ""}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="mt-6 text-gray-500 text-center">
            {tickets.length === 0
              ? "No SBC tickets yet. Tickets are created when users request plans not in the catalog."
              : "No tickets match the current filters."}
          </p>
        )}
      </div>

      {/* Notes modal */}
      {noteModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Ticket Notes</h2>
              <button
                onClick={() => { setNoteModal(null); setNewNote(""); }}
                className="text-gray-400 hover:text-gray-600"
              >
                &times;
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {noteModal.notes.length === 0 && (
                <p className="text-sm text-gray-400">No notes yet.</p>
              )}
              {noteModal.notes.map((note, i) => (
                <div key={i} className="p-3 bg-gray-50 rounded text-sm">
                  <div className="flex items-center justify-between text-xs text-gray-400">
                    <span>{note.agent}</span>
                    <span>{new Date(note.date).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 text-gray-700">{note.text}</p>
                </div>
              ))}
            </div>
            <div className="p-4 border-t">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Add a note..."
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addNote(noteModal.ticketId)}
                  className="flex-1 text-sm border rounded px-3 py-2"
                />
                <button
                  onClick={() => addNote(noteModal.ticketId)}
                  disabled={!newNote.trim()}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
