"use client";

import { useEffect, useState } from "react";

interface UserDetail {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  firebase_uid: string;
  created_at: string;
  profiles: {
    insurer: string | null;
    plan_type: string | null;
    state: string | null;
    primary_concern: string | null;
  }[] | null;
  stripe_customers: {
    stripe_customer_id: string;
    subscription_status: string;
    subscription_tier: string;
    current_period_end: string | null;
  }[] | null;
  documents: {
    id: string;
    file_name: string;
    doc_type: string;
    status: string;
    created_at: string;
  }[] | null;
  consent_events: {
    consent_type: string;
    consent_version: string;
    granted: boolean;
    created_at: string;
  }[] | null;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  async function loadUsers(q?: string) {
    setLoading(true);
    const url = q ? `/api/admin/users?q=${encodeURIComponent(q)}` : "/api/admin/users";
    const res = await fetch(url);
    const data = await res.json();
    setUsers(data.users || []);
    setLoading(false);
  }

  useEffect(() => {
    loadUsers();
  }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    loadUsers(search);
  }

  const statusColor: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    trialing: "bg-blue-100 text-blue-700",
    canceled: "bg-red-100 text-red-700",
    past_due: "bg-yellow-100 text-yellow-700",
    none: "bg-gray-100 text-gray-500",
    free: "bg-gray-100 text-gray-500",
    pro: "bg-purple-100 text-purple-700",
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">User Lookup</h1>

      {/* Search */}
      <form onSubmit={handleSearch} className="mt-4 flex gap-2 max-w-lg">
        <input
          type="text"
          placeholder="Search by email or name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          Search
        </button>
        {search && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              loadUsers();
            }}
            className="px-3 py-2 bg-gray-200 text-gray-700 text-sm rounded-lg hover:bg-gray-300"
          >
            Clear
          </button>
        )}
      </form>

      {loading ? (
        <div className="mt-6 text-gray-500">Loading users...</div>
      ) : (
        <div className="mt-6 space-y-2">
          <p className="text-sm text-gray-500">{users.length} user{users.length !== 1 ? "s" : ""} found</p>

          {users.map((u) => {
            const profile = u.profiles?.[0];
            const stripe = u.stripe_customers?.[0];
            const expanded = expandedUser === u.id;

            return (
              <div key={u.id} className="bg-white border rounded-lg">
                {/* Summary row */}
                <button
                  onClick={() => setExpandedUser(expanded ? null : u.id)}
                  className="w-full text-left p-4 hover:bg-gray-50 rounded-lg"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium text-gray-900">{u.email}</span>
                      {u.display_name && (
                        <span className="ml-2 text-gray-500 text-sm">({u.display_name})</span>
                      )}
                      {u.is_admin && (
                        <span className="ml-2 px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded">
                          Admin
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {stripe && (
                        <>
                          <span className={`px-2 py-0.5 rounded ${statusColor[stripe.subscription_tier] || ""}`}>
                            {stripe.subscription_tier}
                          </span>
                          <span className={`px-2 py-0.5 rounded ${statusColor[stripe.subscription_status] || ""}`}>
                            {stripe.subscription_status}
                          </span>
                        </>
                      )}
                      <span className="text-gray-400">
                        {new Date(u.created_at).toLocaleDateString()}
                      </span>
                      <span className="text-gray-400">{expanded ? "▲" : "▼"}</span>
                    </div>
                  </div>
                </button>

                {/* Expanded detail */}
                {expanded && (
                  <div className="px-4 pb-4 border-t space-y-4">
                    {/* IDs */}
                    <div className="pt-3">
                      <h3 className="text-xs font-semibold text-gray-500 uppercase">Identifiers</h3>
                      <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-gray-400">Supabase ID:</span>{" "}
                          <code className="bg-gray-100 px-1 rounded">{u.id}</code>
                        </div>
                        <div>
                          <span className="text-gray-400">Firebase UID:</span>{" "}
                          <code className="bg-gray-100 px-1 rounded">{u.firebase_uid}</code>
                        </div>
                        {stripe && (
                          <div>
                            <span className="text-gray-400">Stripe ID:</span>{" "}
                            <code className="bg-gray-100 px-1 rounded">{stripe.stripe_customer_id}</code>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Profile */}
                    {profile && (
                      <div>
                        <h3 className="text-xs font-semibold text-gray-500 uppercase">Profile</h3>
                        <div className="mt-1 grid grid-cols-2 gap-2 text-sm">
                          <div><span className="text-gray-400">Insurer:</span> {profile.insurer || "—"}</div>
                          <div><span className="text-gray-400">Plan:</span> {profile.plan_type || "—"}</div>
                          <div><span className="text-gray-400">State:</span> {profile.state || "—"}</div>
                          <div><span className="text-gray-400">Concern:</span> {profile.primary_concern || "—"}</div>
                        </div>
                      </div>
                    )}

                    {/* Documents */}
                    {u.documents && u.documents.length > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold text-gray-500 uppercase">
                          Documents ({u.documents.length})
                        </h3>
                        <div className="mt-1 space-y-1">
                          {u.documents.map((doc) => (
                            <div key={doc.id} className="flex items-center gap-2 text-xs">
                              <span className="text-gray-700">{doc.file_name}</span>
                              <span className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-500">
                                {doc.doc_type}
                              </span>
                              <span
                                className={`px-1.5 py-0.5 rounded ${
                                  doc.status === "processed"
                                    ? "bg-green-100 text-green-700"
                                    : doc.status === "error"
                                    ? "bg-red-100 text-red-700"
                                    : "bg-yellow-100 text-yellow-700"
                                }`}
                              >
                                {doc.status}
                              </span>
                              <span className="text-gray-400">
                                {new Date(doc.created_at).toLocaleDateString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Consent */}
                    {u.consent_events && u.consent_events.length > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold text-gray-500 uppercase">
                          Consent Events ({u.consent_events.length})
                        </h3>
                        <div className="mt-1 space-y-1">
                          {u.consent_events.map((ce, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs">
                              <span className="text-gray-700">{ce.consent_type}</span>
                              <span className="text-gray-400">v{ce.consent_version}</span>
                              <span
                                className={`px-1.5 py-0.5 rounded ${
                                  ce.granted
                                    ? "bg-green-100 text-green-700"
                                    : "bg-red-100 text-red-700"
                                }`}
                              >
                                {ce.granted ? "Granted" : "Revoked"}
                              </span>
                              <span className="text-gray-400">
                                {new Date(ce.created_at).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Subscription detail */}
                    {stripe && (
                      <div>
                        <h3 className="text-xs font-semibold text-gray-500 uppercase">Subscription</h3>
                        <div className="mt-1 grid grid-cols-2 gap-2 text-sm">
                          <div><span className="text-gray-400">Status:</span> {stripe.subscription_status}</div>
                          <div><span className="text-gray-400">Tier:</span> {stripe.subscription_tier}</div>
                          <div>
                            <span className="text-gray-400">Period end:</span>{" "}
                            {stripe.current_period_end
                              ? new Date(stripe.current_period_end).toLocaleDateString()
                              : "—"}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
