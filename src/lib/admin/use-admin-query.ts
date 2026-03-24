"use client";

import { useAuth } from "@/lib/auth/auth-context";

interface QueryOptions {
  table: string;
  select?: string;
  filters?: Array<{ column: string; op: string; value: unknown }>;
  order?: { column: string; ascending?: boolean };
  limit?: number;
}

export function useAdminQuery() {
  const { user } = useAuth();

  async function getToken() {
    if (!user) throw new Error("Not authenticated");
    return user.firebaseUser.getIdToken();
  }

  async function query(options: QueryOptions) {
    const idToken = await getToken();
    const res = await fetch("/api/admin/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(options),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Query failed");
    }
    const { data } = await res.json();
    return data;
  }

  async function update(table: string, id: string, updates: Record<string, unknown>) {
    const idToken = await getToken();
    const res = await fetch("/api/admin/query", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ table, id, updates }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Update failed");
    }
  }

  return { query, update };
}
