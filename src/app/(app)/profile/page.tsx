"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";

const INSURERS = [
  "Aetna",
  "Anthem / Blue Cross Blue Shield",
  "Cigna",
  "Humana",
  "Kaiser Permanente",
  "Molina Healthcare",
  "Oscar Health",
  "UnitedHealthcare",
  "Other",
];

const PLAN_TYPES = ["HMO", "PPO", "EPO", "HDHP", "Medicare", "Medicare Advantage", "Medicaid", "Other"];

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

export default function ProfilePage() {
  const { user } = useAuth();
  const [insurer, setInsurer] = useState("");
  const [planType, setPlanType] = useState("");
  const [state, setState] = useState("");
  const [primaryConcern, setPrimaryConcern] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const supabase = createBrowserClient();

    async function loadProfile() {
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", user!.userId)
        .single();

      if (data) {
        setInsurer(data.insurer || "");
        setPlanType(data.plan_type || "");
        setState(data.state || "");
        setPrimaryConcern(data.primary_concern || "");
      }
      setLoading(false);
    }

    loadProfile();
  }, [user]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    setSaved(false);

    const supabase = createBrowserClient();
    await supabase.from("profiles").upsert(
      {
        user_id: user.userId,
        insurer: insurer || null,
        plan_type: planType || null,
        state: state || null,
        primary_concern: primaryConcern || null,
      },
      { onConflict: "user_id" }
    );

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  if (loading) {
    return <div className="text-gray-500">Loading profile...</div>;
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900">Your Profile</h1>
      <p className="mt-2 text-gray-600">
        Adding your insurance details helps us provide more accurate audits.
      </p>

      <form onSubmit={handleSave} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Insurer</label>
          <select
            value={insurer}
            onChange={(e) => setInsurer(e.target.value)}
            className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select your insurer</option>
            {INSURERS.map((i) => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Plan Type</label>
          <select
            value={planType}
            onChange={(e) => setPlanType(e.target.value)}
            className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select plan type</option>
            {PLAN_TYPES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
          <select
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select your state</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Primary Billing Concern
          </label>
          <textarea
            value={primaryConcern}
            onChange={(e) => setPrimaryConcern(e.target.value)}
            placeholder="e.g., I received a $5,000 ER bill that seems too high..."
            rows={3}
            className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
        >
          {saving ? "Saving..." : "Save Profile"}
        </button>

        {saved && (
          <p className="text-green-600 text-sm">Profile saved successfully.</p>
        )}
      </form>
    </div>
  );
}
