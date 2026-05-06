"use client";

import { Suspense, useState, useEffect, useRef, memo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import type { InsuranceCardFields } from "@/app/api/profile/scan-card/route";
import { createBrowserClient } from "@/lib/supabase/client";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// ─── Constants ────────────────────────────────────────────────────────────────

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

const PLAN_TYPES = [
  "HMO",
  "PPO",
  "EPO",
  "HDHP",
  "Medicare",
  "Medicare Advantage",
  "Medicaid",
  "Other",
];

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

const STEPS = [
  { id: "card",        label: "Insurance Card" },
  { id: "plan",        label: "Plan Details" },
  { id: "costs",       label: "Your Costs" },
  { id: "about_you",   label: "About You" },
  { id: "dependents",  label: "Family" },
  { id: "concern",     label: "Your Situation" },
];

// ─── Tip component ─────────────────────────────────────────────────────────

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1.5 text-xs text-gray-400 leading-relaxed">{children}</p>
  );
}

// ─── Field wrapper ─────────────────────────────────────────────────────────

function Field({
  label,
  tip,
  children,
  optional = true,
}: {
  label: React.ReactNode;
  tip?: string;
  children: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-sm font-medium text-gray-700">{label}</label>
        {optional && <span className="text-xs text-gray-400">Optional</span>}
      </div>
      {children}
      {tip && <Tip>{tip}</Tip>}
    </div>
  );
}

const inputClass =
  "w-full px-3.5 py-2.5 text-sm border border-gray-200 rounded-xl bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow";

const selectClass =
  "w-full px-3.5 py-2.5 text-sm border border-gray-200 rounded-xl bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow appearance-none";

// ─── Card visual tip ────────────────────────────────────────────────────────

function CardDiagram() {
  return (
    <div className="relative mx-auto w-full max-w-sm rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-600 to-blue-800 p-5 shadow-lg text-white text-xs font-mono select-none">
      <div className="flex justify-between items-start mb-4">
        <div className="text-base font-bold tracking-wide opacity-90">Your Insurer</div>
        <div className="opacity-60 text-right">Insurance Card</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="opacity-60 text-[10px] uppercase tracking-widest mb-0.5">Member Name</div>
          <div className="font-semibold">Your Name</div>
        </div>
        <div>
          <div className="opacity-60 text-[10px] uppercase tracking-widest mb-0.5">Plan Type</div>
          <div className="font-semibold">PPO / HMO</div>
        </div>
        <div className="bg-white/10 rounded-lg p-2">
          <div className="opacity-70 text-[10px] uppercase tracking-widest mb-0.5">Member ID ←</div>
          <div className="font-bold text-yellow-200">XYZ123456789</div>
        </div>
        <div className="bg-white/10 rounded-lg p-2">
          <div className="opacity-70 text-[10px] uppercase tracking-widest mb-0.5">Group # ←</div>
          <div className="font-bold text-yellow-200">A12345</div>
        </div>
        <div>
          <div className="opacity-60 text-[10px] uppercase tracking-widest mb-0.5">PCP Copay</div>
          <div className="font-semibold">$25</div>
        </div>
        <div>
          <div className="opacity-60 text-[10px] uppercase tracking-widest mb-0.5">Specialist</div>
          <div className="font-semibold">$50</div>
        </div>
      </div>
      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-yellow-300 opacity-70" />
    </div>
  );
}

// ─── Step progress bar ──────────────────────────────────────────────────────

function StepProgress({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5 mb-8">
      {STEPS.map((step, i) => (
        <div key={step.id} className="flex items-center gap-1.5 flex-1">
          <div
            className={`flex-1 h-1 rounded-full transition-all duration-300 ${
              i < current ? "bg-blue-600" : i === current ? "bg-blue-300" : "bg-gray-100"
            }`}
          />
          {i < STEPS.length - 1 && null}
        </div>
      ))}
    </div>
  );
}

// ─── Profile types ──────────────────────────────────────────────────────────

interface ProfileData {
  insurer: string;
  plan_type: string;
  plan_name: string;
  state: string;
  group_number: string;
  member_id: string;
  // In-network costs
  in_deductible_individual: string;
  in_deductible_family: string;
  in_oop_max_individual: string;
  in_oop_max_family: string;
  // Out-of-network costs
  out_deductible_individual: string;
  out_deductible_family: string;
  out_oop_max_individual: string;
  out_oop_max_family: string;
  // Copays
  copay_primary: string;
  copay_specialist: string;
  copay_er: string;
  copay_urgent_care: string;
  copay_rx: string;
  coinsurance_pct: string;
  primary_concern: string;
  // Demographics
  date_of_birth: string;
  sex: string;
  phone: string;
  // Dependents (JSON string of array)
  dependents: string;
  // Address / county
  zip_code: string;
  county_fips: string;
  county_name: string;
  city: string;
  address_line1: string;
  address_line2: string;
  // Plan matching
  matched_plan_id: string;
  plan_source: string; // 'employer', 'marketplace', 'off_exchange', 'medicare', 'medicaid'
}

interface PlanSearchResult {
  id: string;
  hiosId: string;
  name: string;
  type: string;
  state: string;
  metalLevel: string;
  premium: number;
  deductible: number;
  oopMax: number;
  year: number;
  hasSbcUrl: boolean;
  dataStatus: string;
}

interface Dependent {
  name: string;
  relationship: string; // "spouse" | "partner" | "child" | "other"
  date_of_birth: string;
  sex: string;
  on_same_plan: boolean;
}

const EMPTY_PROFILE: ProfileData = {
  insurer: "",
  plan_type: "",
  plan_name: "",
  state: "",
  group_number: "",
  member_id: "",
  in_deductible_individual: "",
  in_deductible_family: "",
  in_oop_max_individual: "",
  in_oop_max_family: "",
  out_deductible_individual: "",
  out_deductible_family: "",
  out_oop_max_individual: "",
  out_oop_max_family: "",
  copay_primary: "",
  copay_specialist: "",
  copay_er: "",
  copay_urgent_care: "",
  copay_rx: "",
  coinsurance_pct: "",
  primary_concern: "",
  date_of_birth: "",
  sex: "",
  phone: "",
  zip_code: "",
  county_fips: "",
  county_name: "",
  city: "",
  address_line1: "",
  address_line2: "",
  dependents: "[]",
  matched_plan_id: "",
  plan_source: "",
};

const PLAN_SOURCES = [
  { value: "employer", label: "Employer / Group Plan" },
  { value: "marketplace", label: "Healthcare.gov / State Exchange" },
  { value: "off_exchange", label: "Individual (Off-Exchange)" },
  { value: "medicare", label: "Medicare" },
  { value: "medicaid", label: "Medicaid" },
];

// ─── Main component ─────────────────────────────────────────────────────────

export default function ProfilePage() {
  return (
    <Suspense>
      <ProfileContent />
    </Suspense>
  );
}

function ProfileContent() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isOnboarding = searchParams.get("onboarding") === "true";
  const needsCardRescan = searchParams.get("rescan_card") === "1";
  const prefillPhone = searchParams.get("phone") || "";
  const prefillDob = searchParams.get("dob") || "";

  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<ProfileData>({
    ...EMPTY_PROFILE,
    phone: prefillPhone ? formatPhone(prefillPhone) : "",
    date_of_birth: prefillDob,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedGlobal, setSavedGlobal] = useState(false);
  const [editMode, setEditMode] = useState(isOnboarding);
  const [hasExistingProfile, setHasExistingProfile] = useState(false);

  // User documents
  const [userDocs, setUserDocs] = useState<{ id: string; file_name: string; doc_type: string; status: string; created_at: string }[]>([]);

  useEffect(() => {
    if (!user) return;
    const supabase = createBrowserClient();
    supabase
      .from("documents")
      .select("id, file_name, doc_type, status, created_at")
      .eq("user_id", user.userId)
      .neq("doc_type", "insurance_card")
      .order("created_at", { ascending: false })
      .then(({ data }) => { if (data) setUserDocs(data); });
  }, [user]);

  // Card upload state
  const [cardFile, setCardFile] = useState<File | null>(null);
  const [cardDragging, setCardDragging] = useState(false);
  const [cardScanning, setCardScanning] = useState(false);
  const [cardScanned, setCardScanned] = useState(false);
  const [cardError, setCardError] = useState("");
  const [cardScanAttempts, setCardScanAttempts] = useState(0);
  const [cardPlanMismatch, setCardPlanMismatch] = useState<{
    type: "different_insurer" | "same_insurer_different_plan" | "same_insurer_uncertain" | "missing_insurer";
    existingInsurer: string;
    newInsurer: string;
    existingPlanName?: string;
    newPlanName?: string;
    pendingData: Partial<Record<keyof ProfileData, string>>;
    planMatches: { planId: string; planName: string; insurerName: string; confidence: number }[];
  } | null>(null);
  const [pendingCanonicalMatch, setPendingCanonicalMatch] = useState<{ canonicalPlanId: string; matchedPlanName: string; confidence: number; sourceCount: number; insurerName: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Load existing profile ─────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;

    async function load() {
      try {
        const idToken = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/profile", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (res.ok) {
          const { profile: p, insurancePlan: ip } = await res.json();
          if (p) {
            // Helper: pick first non-null value and stringify
            const num = (...vals: unknown[]) => {
              for (const v of vals) { if (v != null) return String(v); }
              return "";
            };
            const loaded: ProfileData = {
              insurer: p.insurer || "",
              plan_type: p.plan_type || "",
              plan_name: p.plan_name || "",
              state: p.state || "",
              group_number: p.group_number || "",
              member_id: p.member_id || "",
              in_deductible_individual: num(p.deductible_individual, ip?.in_deductible_individual),
              in_deductible_family: num(p.in_deductible_family, ip?.in_deductible_family),
              in_oop_max_individual: num(p.oop_max_individual, ip?.in_oop_max_individual),
              in_oop_max_family: num(p.in_oop_max_family, ip?.in_oop_max_family),
              out_deductible_individual: num(p.out_deductible_individual, ip?.out_deductible_individual),
              out_deductible_family: num(p.out_deductible_family, ip?.out_deductible_family),
              out_oop_max_individual: num(p.out_oop_max_individual, ip?.out_oop_max_individual),
              out_oop_max_family: num(p.out_oop_max_family, ip?.out_oop_max_family),
              copay_primary: num(p.copay_primary, ip?.copay_primary),
              copay_specialist: num(p.copay_specialist, ip?.copay_specialist),
              copay_er: num(p.copay_er, ip?.copay_er),
              copay_urgent_care: num(p.copay_urgent_care, ip?.copay_urgent_care),
              copay_rx: num(p.copay_rx, ip?.copay_rx),
              coinsurance_pct: num(p.coinsurance_pct, ip?.coinsurance_pct),
              primary_concern: p.primary_concern || "",
              date_of_birth: p.date_of_birth || prefillDob || "",
              sex: p.sex || "",
              phone: p.phone || (prefillPhone ? formatPhone(prefillPhone) : ""),
              zip_code: p.zip_code || "",
              county_fips: p.county_fips || "",
              county_name: p.county_name || "",
              city: p.city || "",
              address_line1: p.address_line1 || "",
              address_line2: p.address_line2 || "",
              dependents: p.dependents ? JSON.stringify(p.dependents) : "[]",
              matched_plan_id: p.matched_plan_id || "",
              plan_source: p.plan_source || "",
            };
            setProfile(loaded);
            const hasSomeData = Object.entries(loaded).some(([k, v]) => k !== "dependents" && v && v !== "[]");
            setHasExistingProfile(hasSomeData);
            // Auto-save prefill values from signup so they survive navigation
            if (isOnboarding) {
              const prefillSave: Partial<Record<keyof ProfileData, string>> = {};
              if (prefillDob && !p.date_of_birth) prefillSave.date_of_birth = prefillDob;
              if (prefillPhone && !p.phone) prefillSave.phone = prefillPhone;
              if (Object.keys(prefillSave).length > 0) {
                saveStep(prefillSave);
              }
            }
            // If returning to profile with existing data, skip card upload step
            if (hasSomeData && isOnboarding && step === 0) setStep(1);
            // If no existing data and not onboarding, go straight to edit
            if (!hasSomeData && !isOnboarding) setEditMode(true);
          } else if (!isOnboarding) {
            setEditMode(true);
          }
        }
      } catch (err) {
        console.error("Failed to load profile:", err);
      }
      setLoading(false);
    }

    load();
  }, [user]);

  // ── Save current step's data ──────────────────────────────────────────────
  async function saveStep(data: Partial<Record<keyof ProfileData, string>>): Promise<{
    insurerMismatch?: { existingInsurer: string; newInsurer: string };
    planMismatch?: { type: "different_insurer" | "same_insurer_different_plan" | "same_insurer_uncertain"; existingInsurer: string; newInsurer: string; existingPlanName?: string; newPlanName?: string };
    pendingCanonicalMatch?: { canonicalPlanId: string; matchedPlanName: string; confidence: number; sourceCount: number; insurerName: string };
  } | null> {
    if (!user) return null;
    setSaving(true);
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const body: Record<string, string | number | null> = {};
      for (const [k, v] of Object.entries(data)) {
        body[k] = v || null;
      }
      // Convert numeric fields
      const numericFields = [
        "in_deductible_individual","in_deductible_family","in_oop_max_individual","in_oop_max_family",
        "out_deductible_individual","out_deductible_family","out_oop_max_individual","out_oop_max_family",
        "copay_primary","copay_specialist","copay_er","copay_urgent_care","copay_rx","coinsurance_pct",
      ];
      for (const field of numericFields) {
        if (field in body && body[field] != null) {
          const raw = (body[field] as string).replace(/,/g, "");
          const num = parseFloat(raw);
          body[field] = isNaN(num) ? null : num;
        }
      }
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        console.error("Profile save failed:", res.status, errBody);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error("Failed to save:", err);
      return null;
    } finally {
      setSaving(false);
    }
  }

  // ── Step navigation ───────────────────────────────────────────────────────
  async function advance(data?: Partial<Record<keyof ProfileData, string>>) {
    if (data) {
      setProfile((prev) => ({ ...prev, ...data }));
      await saveStep(data);
    }
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      // Done
      if (isOnboarding) {
        router.push("/upload?need_sbc=1");
      } else {
        setEditMode(false);
        setHasExistingProfile(true);
        setSavedGlobal(true);
        setTimeout(() => setSavedGlobal(false), 3000);
      }
    }
  }

  function skip() {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      // Last step — exit wizard
      if (isOnboarding) {
        router.push("/upload?need_sbc=1");
      } else {
        // Check if any data was entered during this session
        const hasSomeData = !!(profile.insurer || profile.plan_type || profile.state || profile.group_number || profile.member_id || profile.primary_concern || profile.in_deductible_individual || profile.copay_primary || profile.date_of_birth);
        setHasExistingProfile(hasSomeData);
        setEditMode(false);
      }
    }
  }

  // ── Insurance card scanning ───────────────────────────────────────────────
  async function scanCard(file: File) {
    setCardScanning(true);
    setCardError("");
    try {
      const idToken = await user!.firebaseUser.getIdToken();
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/profile/scan-card", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
        body: fd,
      });
      if (!res.ok) {
        const { error } = await res.json();
        throw new Error(error || "Scan failed");
      }
      const { fields, planMatches: scanPlanMatches }: { fields: InsuranceCardFields; planMatches?: { planId: string; planName: string; insurerName: string; confidence: number }[] } = await res.json();

      // Quality check: did we extract enough meaningful data?
      // At minimum we need insurer OR (member ID with digits)
      const hasInsurer = !!fields.insurer;
      const hasMemberId = !!fields.memberId && /\d/.test(fields.memberId);
      const hasGroupNumber = !!fields.groupNumber;
      const keyFieldCount = [hasInsurer, hasMemberId, hasGroupNumber].filter(Boolean).length;

      if (keyFieldCount < 2) {
        // Not enough data extracted — count as a failed scan
        throw new Error("Could not read enough details from the card. Try a clearer photo or enter details manually.");
      }

      // Pre-fill profile fields with extracted values
      setProfile((prev) => ({
        ...prev,
        insurer: fields.insurer || prev.insurer,
        plan_type: fields.planType || prev.plan_type,
        plan_name: fields.planName || prev.plan_name,
        group_number: fields.groupNumber || prev.group_number,
        member_id: fields.memberId || prev.member_id,
        in_deductible_individual: fields.deductibleIndividual != null
          ? String(fields.deductibleIndividual) : prev.in_deductible_individual,
        in_deductible_family: fields.deductibleFamily != null
          ? String(fields.deductibleFamily) : prev.in_deductible_family,
        in_oop_max_individual: fields.oopMaxIndividual != null
          ? String(fields.oopMaxIndividual) : prev.in_oop_max_individual,
        in_oop_max_family: fields.oopMaxFamily != null
          ? String(fields.oopMaxFamily) : prev.in_oop_max_family,
        copay_primary: fields.copayPrimary != null
          ? String(fields.copayPrimary) : prev.copay_primary,
        copay_specialist: fields.copaySpecialist != null
          ? String(fields.copaySpecialist) : prev.copay_specialist,
        copay_er: fields.copayEr != null
          ? String(fields.copayEr) : prev.copay_er,
        copay_urgent_care: fields.copayUrgentCare != null
          ? String(fields.copayUrgentCare) : prev.copay_urgent_care,
        copay_rx: fields.copayRx != null
          ? String(fields.copayRx) : prev.copay_rx,
        coinsurance_pct: fields.coinsurancePct != null
          ? String(fields.coinsurancePct) : prev.coinsurance_pct,
        zip_code: fields.zipCode || prev.zip_code,
      }));
      setCardScanned(true);

      // Auto-save extracted fields to backend immediately so data persists on navigate
      const cardData = {
        insurer: fields.insurer || undefined,
        plan_type: fields.planType || undefined,
        plan_name: fields.planName || undefined,
        group_number: fields.groupNumber || undefined,
        member_id: fields.memberId || undefined,
        in_deductible_individual: fields.deductibleIndividual != null ? String(fields.deductibleIndividual) : undefined,
        in_deductible_family: fields.deductibleFamily != null ? String(fields.deductibleFamily) : undefined,
        in_oop_max_individual: fields.oopMaxIndividual != null ? String(fields.oopMaxIndividual) : undefined,
        in_oop_max_family: fields.oopMaxFamily != null ? String(fields.oopMaxFamily) : undefined,
        copay_primary: fields.copayPrimary != null ? String(fields.copayPrimary) : undefined,
        copay_specialist: fields.copaySpecialist != null ? String(fields.copaySpecialist) : undefined,
        copay_er: fields.copayEr != null ? String(fields.copayEr) : undefined,
        copay_urgent_care: fields.copayUrgentCare != null ? String(fields.copayUrgentCare) : undefined,
        copay_rx: fields.copayRx != null ? String(fields.copayRx) : undefined,
        coinsurance_pct: fields.coinsurancePct != null ? String(fields.coinsurancePct) : undefined,
        zip_code: fields.zipCode || undefined,
        plan_source: "insurance_card",
      } as Partial<Record<keyof ProfileData, string>>;

      const result = await saveStep(cardData);

      // Check if the backend detected a plan mismatch (different insurer, same insurer different plan, or uncertain)
      if (result?.planMismatch) {
        setCardPlanMismatch({
          ...result.planMismatch,
          pendingData: cardData,
          planMatches: scanPlanMatches || [],
        });
        // Don't advance — show mismatch prompt instead
        setCardScanning(false);
        return;
      }

      // Check if the backend found a canonical plan match needing confirmation
      if (result?.pendingCanonicalMatch) {
        setPendingCanonicalMatch(result.pendingCanonicalMatch);
      }
      setHasExistingProfile(true);
    } catch (err) {
      const attempts = cardScanAttempts + 1;
      setCardScanAttempts(attempts);
      if (attempts >= 2) {
        setCardError("Card scan didn't work — let's enter your details manually instead.");
        // Auto-advance to manual entry after 2 failures
        setTimeout(() => setStep(1), 1500);
      } else {
        setCardError(err instanceof Error ? err.message : "Could not read card. Try again or enter details manually.");
      }
    } finally {
      setCardScanning(false);
    }
  }

  function handleCardDrop(e: React.DragEvent) {
    e.preventDefault();
    setCardDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      setCardFile(file);
      scanCard(file);
    }
  }

  function handleCardFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setCardFile(file);
      scanCard(file);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-32">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const isLastStep = step === STEPS.length - 1;
  const headerTitle = isOnboarding ? "Set up your profile" : "Your Profile";

  // ── Read-only profile view (non-onboarding, has data, not editing) ──────
  if (!editMode && hasExistingProfile && !isOnboarding) {
    // Profile is "functional" if we have enough to identify the plan:
    // insurer + plan_type, OR group_number + plan_type, OR insurer + group_number
    const identifiers = [profile.insurer, profile.plan_type, profile.group_number, profile.state].filter(Boolean).length;
    const allFields = [profile.insurer, profile.plan_type, profile.plan_name, profile.state, profile.group_number, profile.in_deductible_individual, profile.copay_primary, profile.phone, profile.date_of_birth];
    const filledCount = allFields.filter(Boolean).length;
    const totalCount = allFields.length;
    const allFilled = identifiers >= 2 && !!profile.phone && !!profile.date_of_birth;

    return (
      <div className="max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Your Profile</h1>
            {allFilled && (
              <p className="text-xs text-green-600 font-medium mt-0.5">Profile 100% complete</p>
            )}
          </div>
          <button
            onClick={() => { setEditMode(true); setStep(1); }}
            className="px-4 py-2 text-sm font-semibold text-blue-600 border border-blue-200 rounded-xl hover:bg-blue-50 transition-colors"
          >
            {allFilled ? "Update insurance info" : "Complete profile"}
          </button>
        </div>

        {needsCardRescan && (
          <div className="mb-5 p-4 bg-amber-50 border border-amber-200 rounded-2xl">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-900">Scan your new insurance card</p>
                <p className="text-xs text-amber-700 mt-0.5">You switched plans. Upload your new card so we can update your member ID and group number.</p>
              </div>
            </div>
            <button
              onClick={() => { setEditMode(true); setStep(0); }}
              className="mt-3 w-full py-2.5 bg-amber-600 text-white rounded-xl text-xs font-semibold hover:bg-amber-700 transition-colors"
            >
              Scan new card
            </button>
          </div>
        )}

        {!allFilled && (
          <div className="mb-5 p-4 bg-blue-50 border border-blue-100 rounded-2xl">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <p className="text-sm font-medium text-blue-800">
                  Profile {Math.round((filledCount / totalCount) * 100)}% complete
                </p>
                <p className="text-xs text-blue-600 mt-0.5">Add more details for better audit accuracy and personalized benefits.</p>
              </div>
            </div>
            <div className="mt-2 h-1.5 bg-blue-200 rounded-full overflow-hidden">
              <div className="h-full bg-blue-600 rounded-full" style={{ width: `${Math.round((filledCount / totalCount) * 100)}%` }} />
            </div>
          </div>
        )}

        {savedGlobal && (
          <div className="mb-5 flex items-center gap-2 p-3 bg-green-50 border border-green-100 rounded-xl">
            <svg className="w-4 h-4 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
            <p className="text-sm text-green-700 font-medium">Profile saved.</p>
          </div>
        )}

        <div className="space-y-4">
          {/* Account info from Firebase + profile */}
          <ProfileSection title="Account">
            <ProfileField label="Email" value={user?.firebaseUser.email || ""} />
            <ProfileField label="Name" value={user?.firebaseUser.displayName || ""} />
            <ProfileField label="Sign-in method" value={
              user?.firebaseUser.providerData?.[0]?.providerId === "google.com" ? "Google" :
              user?.firebaseUser.providerData?.[0]?.providerId === "password" ? "Email & Password" :
              user?.firebaseUser.providerData?.[0]?.providerId || "Unknown"
            } />
            <ProfileField label="Phone" value={profile.phone || ""} />
          </ProfileSection>
          <ProfileSection title="Insurance">
            <ProfileField label="Insurer" value={profile.insurer} />
            <ProfileField label="Plan name" value={profile.plan_name} />
            <ProfileField label="Plan type" value={profile.plan_type} />
            <ProfileField label="State" value={profile.state} />
            <ProfileField label="Group #" value={profile.group_number} />
            <ProfileField label="Member ID" value={profile.member_id} />
          </ProfileSection>
          <ProfileSection title="Cost Structure">
            <ProfileField label="Deductible (in-network)" value={profile.in_deductible_individual} prefix="$" />
            <ProfileField label="Deductible family" value={profile.in_deductible_family} prefix="$" />
            <ProfileField label="OOP max (in-network)" value={profile.in_oop_max_individual} prefix="$" />
            <ProfileField label="OOP max family" value={profile.in_oop_max_family} prefix="$" />
            <ProfileField label="PCP copay" value={profile.copay_primary} prefix="$" />
            <ProfileField label="Specialist" value={profile.copay_specialist} prefix="$" />
            <ProfileField label="ER copay" value={profile.copay_er} prefix="$" />
            <ProfileField label="Coinsurance" value={profile.coinsurance_pct} suffix="%" />
          </ProfileSection>
          <ProfileSection title="About You">
            <ProfileField label="Date of birth" value={profile.date_of_birth} />
            <ProfileField label="Sex" value={profile.sex === "prefer_not_to_say" ? "Prefer not to say" : profile.sex} />
            <ProfileField label="Address" value={[profile.address_line1, profile.address_line2].filter(Boolean).join(", ")} />
            <ProfileField label="City / Zip" value={[profile.city, profile.zip_code].filter(Boolean).join(", ")} />
            <ProfileField label="County" value={profile.county_name} />
          </ProfileSection>
          {(() => {
            let deps: Dependent[] = [];
            try { deps = JSON.parse(profile.dependents || "[]"); } catch { /* empty */ }
            return deps.length > 0 ? (
              <ProfileSection title="Family">
                {deps.map((d: Dependent, i: number) => (
                  <div key={i} className="col-span-2 flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{d.name || "Unnamed"}</p>
                      <p className="text-xs text-gray-400">{d.relationship}{d.date_of_birth ? ` · Born ${d.date_of_birth}` : ""}</p>
                    </div>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${d.on_same_plan ? "bg-blue-50 text-blue-600" : "bg-gray-100 text-gray-500"}`}>
                      {d.on_same_plan ? "On your plan" : "Separate plan"}
                    </span>
                  </div>
                ))}
              </ProfileSection>
            ) : null;
          })()}
          {profile.primary_concern && (
            <ProfileSection title="Your Situation">
              <p className="text-sm text-gray-700 leading-relaxed">{profile.primary_concern}</p>
            </ProfileSection>
          )}

          {/* Uploaded documents */}
          {userDocs.length > 0 && (
            <ProfileSection title="Your Documents">
              <div className="col-span-2 space-y-2">
                {userDocs.map((doc) => (
                  <div key={doc.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{doc.file_name}</p>
                      <p className="text-xs text-gray-400">
                        {doc.doc_type === "eob" ? "EOB" : doc.doc_type === "itemized_bill" ? "Itemized Bill" : doc.doc_type === "sbc" ? "SBC" : doc.doc_type === "plan_document" ? "Plan Doc" : doc.doc_type}
                        {" · "}
                        {new Date(doc.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                      doc.status === "processed" ? "bg-green-50 text-green-600" :
                      doc.status === "processing" || doc.status === "queued" ? "bg-blue-50 text-blue-600" :
                      doc.status === "pending_review" ? "bg-amber-50 text-amber-600" :
                      doc.status === "error" ? "bg-red-50 text-red-600" :
                      "bg-gray-100 text-gray-500"
                    }`}>
                      {doc.status === "processed" ? "Processed" :
                       doc.status === "processing" ? "Processing" :
                       doc.status === "queued" ? "Queued" :
                       doc.status === "pending_review" ? "Under review" :
                       doc.status === "error" ? "Error" :
                       "Uploaded"}
                    </span>
                  </div>
                ))}
                <Link
                  href="/upload"
                  className="inline-flex items-center gap-1 mt-1 text-xs font-semibold text-blue-600 hover:text-blue-800"
                >
                  Upload more documents
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
            </ProfileSection>
          )}

          {/* Privacy & Data link */}
          <div className="mt-6 pt-4 border-t border-gray-100 text-center">
            <Link
              href="/settings"
              className="text-sm text-blue-600 hover:underline"
            >
              Privacy &amp; Data Settings
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{headerTitle}</h1>
        <p className="mt-1.5 text-sm text-gray-500">
          {isOnboarding
            ? "The more you share, the more accurately we can audit your bills."
            : "Update your insurance details to improve audit accuracy."}
        </p>
      </div>

      {/* Step progress */}
      <StepProgress current={step} total={STEPS.length} />

      {/* Step label */}
      <div className="mb-5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-blue-600 uppercase tracking-widest">
            Step {step + 1} of {STEPS.length}
          </span>
          <span className="text-xs text-gray-400">{STEPS[step].label}</span>
        </div>
      </div>

      {/* ── Step 0: Insurance Card ──────────────────────────────────────────── */}
      {step === 0 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Upload your insurance card</h2>
            <p className="text-sm text-gray-500">
              We&apos;ll read your card and pre-fill your plan details automatically.
              Your physical card or a screenshot both work.
            </p>
          </div>

          {/* Card diagram */}
          <CardDiagram />

          {/* Upload zone */}
          {!cardScanned ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setCardDragging(true); }}
              onDragLeave={() => setCardDragging(false)}
              onDrop={handleCardDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center gap-3 p-8 border-2 border-dashed rounded-2xl cursor-pointer transition-all ${
                cardDragging
                  ? "border-blue-400 bg-blue-50"
                  : "border-gray-200 bg-gray-50 hover:border-blue-300 hover:bg-blue-50/50"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={handleCardFileChange}
              />
              {cardScanning ? (
                <>
                  <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-gray-600 font-medium">Reading your card…</p>
                </>
              ) : (
                <>
                  <div className="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center">
                    <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-gray-700">
                      Drop your card here, or <span className="text-blue-600">browse</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-1">Photo, screenshot, or PDF — up to 10MB</p>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-100 rounded-2xl">
              <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-green-800">Card scanned successfully</p>
                <p className="text-xs text-green-600 truncate">{cardFile?.name}</p>
              </div>
              <button
                onClick={() => { setCardScanned(false); setCardFile(null); }}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Rescan
              </button>
            </div>
          )}

          {cardError && (
            <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl">
              <p className="text-xs text-amber-700">{cardError}</p>
            </div>
          )}

          {/* Plan mismatch prompt — three variants */}
          {cardPlanMismatch && (() => {
            const m = cardPlanMismatch;
            const hasMatches = m.planMatches.length > 0;
            const isDifferentInsurer = m.type === "different_insurer";
            const isSameInsurerDifferent = m.type === "same_insurer_different_plan";
            const isUncertain = m.type === "same_insurer_uncertain";
            const isMissingInsurer = m.type === "missing_insurer";

            // Header + description based on mismatch type
            const header = isMissingInsurer
              ? "Could not read insurer from card"
              : isDifferentInsurer
              ? "Different insurer detected"
              : isSameInsurerDifferent
              ? "Different plan detected"
              : "Plan details changed";

            const description = isMissingInsurer
              ? <>We couldn&apos;t read the insurer name from your card. You currently have <strong>{m.existingInsurer}</strong> on file. Is this card for a different plan?</>
              : isDifferentInsurer
              ? <>Your profile currently shows <strong>{m.existingInsurer}</strong>, but this card is from <strong>{m.newInsurer}</strong>.</>
              : isSameInsurerDifferent
              ? <>Same insurer (<strong>{m.existingInsurer}</strong>), but this looks like a different plan. This could mean different benefits, copays, and deductibles.</>
              : <>Same insurer (<strong>{m.existingInsurer}</strong>), but some plan details differ. Is this a new card for your current plan, or a different plan?</>;

            const switchLabel = isMissingInsurer
              ? "This is a different plan"
              : isDifferentInsurer
              ? `Switch to ${m.newInsurer}`
              : "This is a different plan";

            const keepLabel = isUncertain
              ? "Same plan, new card"
              : "Keep current plan";

            async function handleSwitch() {
              const data = { ...m.pendingData };
              // Keep plan_source so the new plan gets correct source (e.g. "insurance_card")
              // Pre-check is already skipped when force_plan_switch is true
              const idToken = await user!.firebaseUser.getIdToken();
              await fetch("/api/profile", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
                body: JSON.stringify({ ...data, force_plan_switch: true }),
              });
              setCardPlanMismatch(null);
              setCardScanned(true);
              setHasExistingProfile(true);
              router.push("/upload?need_sbc=1");
            }

            function handleKeep() {
              setCardPlanMismatch(null);
              if (isUncertain) {
                // "Same plan, new card" — save identity fields only (card replacement)
                // Include plan_source so isCardAfterDoc activates and preserves SBC benefit data
                saveStep({
                  member_id: m.pendingData.member_id,
                  group_number: m.pendingData.group_number,
                  zip_code: m.pendingData.zip_code,
                  plan_source: "insurance_card",
                } as Partial<Record<keyof ProfileData, string>>);
                setCardScanned(true);
              } else {
                setCardScanned(false);
                setCardFile(null);
              }
            }

            return (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl space-y-3">
                <p className="text-sm font-semibold text-amber-900">{header}</p>
                <p className="text-xs text-amber-700">{description}</p>

                <div className="grid grid-cols-2 gap-2">
                  <div className="p-3 bg-white rounded-xl border border-gray-200 text-center">
                    <p className="text-[10px] text-gray-400 uppercase font-semibold">Current</p>
                    <p className="text-sm font-medium text-gray-900 mt-0.5">{m.existingPlanName || m.existingInsurer}</p>
                    {m.existingPlanName && <p className="text-[10px] text-gray-400">{m.existingInsurer}</p>}
                  </div>
                  <div className="p-3 bg-blue-50 rounded-xl border border-blue-200 text-center">
                    <p className="text-[10px] text-blue-500 uppercase font-semibold">New card</p>
                    <p className="text-sm font-medium text-gray-900 mt-0.5">{m.newPlanName || m.newInsurer}</p>
                    {m.newPlanName && <p className="text-[10px] text-blue-400">{m.newInsurer}</p>}
                  </div>
                </div>

                {/* T1.4: Show matched plans from catalog if available */}
                {hasMatches && (isDifferentInsurer || isSameInsurerDifferent || isUncertain) && (
                  <div className="p-3 bg-green-50 rounded-xl border border-green-100">
                    <p className="text-xs font-semibold text-green-800">We found this plan in our database</p>
                    <p className="text-xs text-green-700 mt-0.5">
                      {isUncertain
                        ? `If this is a different plan, we found ${m.planMatches[0].planName} in our database.`
                        : `Switching will load benefit data from ${m.planMatches[0].planName}. You may still want to upload your SBC for the most complete results.`}
                    </p>
                  </div>
                )}

                {/* T1.5: No matches — plan not in DB */}
                {!hasMatches && (isDifferentInsurer || isSameInsurerDifferent) && (
                  <div className="p-3 bg-gray-50 rounded-xl border border-gray-100">
                    <p className="text-xs text-gray-600">
                      Candid doesn&apos;t have this plan in our database yet. Upload your SBC after switching for complete benefit results.
                    </p>
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleSwitch}
                    className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-semibold hover:bg-blue-700 transition-colors"
                  >
                    {switchLabel}
                  </button>
                  <button
                    onClick={handleKeep}
                    className="flex-1 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl text-xs font-semibold hover:bg-gray-50 transition-colors"
                  >
                    {keepLabel}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Canonical plan match confirmation */}
          {pendingCanonicalMatch && (
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-2xl space-y-3">
              <p className="text-sm font-semibold text-blue-900">We found a matching plan</p>
              <p className="text-xs text-blue-700">
                Your card matches a plan we already have in our database. Linking to it will give you access to community-verified benefit data from {pendingCanonicalMatch.sourceCount} other {pendingCanonicalMatch.sourceCount === 1 ? "member" : "members"}.
              </p>
              <div className="p-3 bg-white rounded-xl border border-blue-100">
                <p className="text-sm font-medium text-gray-900">{pendingCanonicalMatch.matchedPlanName}</p>
                <p className="text-xs text-gray-500 mt-0.5">{pendingCanonicalMatch.insurerName} · {Math.round(pendingCanonicalMatch.confidence * 100)}% match</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    try {
                      const idToken = await user!.firebaseUser.getIdToken();
                      await fetch("/api/profile", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
                        body: JSON.stringify({ action: "confirm_canonical_match", canonicalPlanId: pendingCanonicalMatch!.canonicalPlanId }),
                      });
                    } catch (err) {
                      console.error("Failed to confirm canonical match:", err);
                    }
                    setPendingCanonicalMatch(null);
                  }}
                  className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-semibold hover:bg-blue-700 transition-colors"
                >
                  Yes, this is my plan
                </button>
                <button
                  onClick={() => setPendingCanonicalMatch(null)}
                  className="flex-1 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl text-xs font-semibold hover:bg-gray-50 transition-colors"
                >
                  Not my plan
                </button>
              </div>
            </div>
          )}

          {/* Tips */}
          <div className="p-4 bg-gray-50 rounded-2xl space-y-2">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-widest">Where to find your card</p>
            <ul className="text-xs text-gray-500 space-y-1.5">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 w-4 h-4 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-bold shrink-0">1</span>
                Check your physical wallet — most insurers provide a card at enrollment
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 w-4 h-4 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-bold shrink-0">2</span>
                Log into your insurer&apos;s member portal and download a digital card
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 w-4 h-4 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-bold shrink-0">3</span>
                Check your employer&apos;s benefits portal or any welcome email from your insurer
              </li>
            </ul>
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <button
              onClick={() => advance()}
              className="w-full py-3 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors"
            >
              {cardScanned ? "Continue with scanned details →" : "Continue →"}
            </button>
            <button
              onClick={skip}
              className="w-full py-2.5 text-sm text-gray-400 hover:text-gray-600 transition-colors"
            >
              Skip — I&apos;ll enter details manually
            </button>
          </div>
        </div>
      )}

      {/* ── Step 1: Plan Details ────────────────────────────────────────────── */}
      {step === 1 && (
        <PlanDetailsStep
          profile={profile}
          saving={saving}
          onContinue={(data) => advance(data)}
          onSkip={skip}
        />
      )}

      {/* ── Step 2: Your Costs ──────────────────────────────────────────────── */}
      {step === 2 && (
        <CostsStep
          profile={profile}
          saving={saving}
          onContinue={(data) => advance(data)}
          onSkip={skip}
        />
      )}

      {/* ── Step 3: About You ─────────────────────────────────────────────── */}
      {step === 3 && (
        <AboutYouStep
          profile={profile}
          saving={saving}
          isOnboarding={isOnboarding}
          onContinue={(data) => advance(data)}
          onSkip={skip}
        />
      )}

      {/* ── Step 4: Family & Dependents ───────────────────────────────────── */}
      {step === 4 && (
        <DependentsStep
          profile={profile}
          saving={saving}
          onContinue={(data) => advance(data)}
          onSkip={skip}
        />
      )}

      {/* ── Step 5: Primary Concern ─────────────────────────────────────────── */}
      {step === 5 && (
        <ConcernStep
          profile={profile}
          saving={saving}
          isOnboarding={isOnboarding}
          isLastStep={isLastStep}
          savedGlobal={savedGlobal}
          onContinue={(data) => advance(data)}
          onSkip={skip}
        />
      )}

      {/* Back nav */}
      {step > 0 && (
        <button
          onClick={() => setStep(step - 1)}
          className="mt-4 flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
      )}
    </div>
  );
}

// ─── Step sub-components ─────────────────────────────────────────────────────

function PlanDetailsStep({
  profile,
  saving,
  onContinue,
  onSkip,
}: {
  profile: ProfileData;
  saving: boolean;
  onContinue: (data: Partial<ProfileData>) => void;
  onSkip: () => void;
}) {
  const { user } = useAuth();
  const [insurer, setInsurer] = useState(profile.insurer);
  const [planType, setPlanType] = useState(profile.plan_type);
  const [planName, setPlanName] = useState(profile.plan_name);
  const [state, setState] = useState(profile.state);
  const [groupNumber, setGroupNumber] = useState(profile.group_number);
  const [memberId, setMemberId] = useState(profile.member_id);
  const [planSource, setPlanSource] = useState(profile.plan_source);
  const [matchedPlanId, setMatchedPlanId] = useState(profile.matched_plan_id);
  const [matchedPlan, setMatchedPlan] = useState<PlanSearchResult | null>(null);

  // Plan name autocomplete
  const [planSuggestions, setPlanSuggestions] = useState<PlanSearchResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searchingPlans, setSearchingPlans] = useState(false);
  const searchTimeout = useRef<NodeJS.Timeout | null>(null);

  function handlePlanNameChange(value: string) {
    setPlanName(value);
    setMatchedPlanId("");
    setMatchedPlan(null);

    // Debounced search
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (value.length < 3 || !user) {
      setPlanSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    searchTimeout.current = setTimeout(async () => {
      setSearchingPlans(true);
      try {
        const token = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/plan/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ query: value, insurer, state }),
        });
        if (res.ok) {
          const { plans } = await res.json();
          setPlanSuggestions(plans || []);
          setShowSuggestions((plans || []).length > 0);
        }
      } catch {
        // Non-critical
      }
      setSearchingPlans(false);
    }, 400);
  }

  function selectPlan(plan: PlanSearchResult) {
    setPlanName(plan.name);
    setMatchedPlanId(plan.id);
    setMatchedPlan(plan);
    setShowSuggestions(false);
    // Auto-fill plan type and state if available
    if (plan.type && !planType) setPlanType(plan.type);
    if (plan.state && !state) setState(plan.state);
  }

  const hasAny = insurer || planType || planName || state || groupNumber || memberId;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Plan details</h2>
        <p className="text-sm text-gray-500">
          This tells us which benefits apply to your plan and how to read your EOBs.
        </p>
      </div>

      <Field label="Insurance company">
        <select value={insurer} onChange={(e) => setInsurer(e.target.value)} className={selectClass}>
          <option value="">Select your insurer</option>
          {INSURERS.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <Tip>The company name on your insurance card.</Tip>
      </Field>

      {insurer === "Other" && (
        <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl">
          <p className="text-sm font-medium text-blue-800">Help us support your insurer</p>
          <p className="text-xs text-blue-600 mt-1">
            Upload your plan document (Summary of Benefits and Coverage) and we&apos;ll have your plan&apos;s specific benefits ready within 48 hours.
          </p>
          <Link
            href="/upload"
            className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-blue-700 hover:text-blue-900"
          >
            Upload plan document
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      )}

      <Field label={<>How do you get your insurance?{!planSource && <span className="ml-1 text-amber-500 text-[10px] font-medium">(please select)</span>}</>}>
        <div className={`grid grid-cols-2 gap-2 ${!planSource ? "ring-1 ring-amber-300 rounded-xl p-1" : ""}`}>
          {PLAN_SOURCES.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setPlanSource(opt.value)}
              className={`px-3 py-2 text-xs font-medium rounded-xl border-2 transition-all text-left ${
                planSource === opt.value
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-gray-200 text-gray-600 hover:border-gray-300"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Plan name">
        <div className="relative">
          <input
            type="text"
            value={planName}
            onChange={(e) => handlePlanNameChange(e.target.value)}
            onFocus={() => planSuggestions.length > 0 && setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
            placeholder="e.g., Aetna Choice POS II, BCBS Blue Preferred"
            className={inputClass}
          />
          {searchingPlans && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {showSuggestions && planSuggestions.length > 0 && (
            <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-60 overflow-y-auto">
              {planSuggestions.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectPlan(plan)}
                  className="w-full text-left px-3 py-2.5 hover:bg-blue-50 border-b border-gray-100 last:border-b-0"
                >
                  <p className="text-sm font-medium text-gray-900">{plan.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {plan.type} · {plan.metalLevel} · {plan.state}
                    {plan.deductible != null && ` · $${plan.deductible.toLocaleString()} deductible`}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
        {matchedPlan ? (
          <div className="mt-1.5 p-2.5 bg-green-50 border border-green-100 rounded-xl">
            <p className="text-xs font-medium text-green-700">
              Plan matched: {matchedPlan.name} ({matchedPlan.type}, {matchedPlan.metalLevel})
            </p>
            <p className="text-xs text-green-600 mt-0.5">
              Deductible: ${matchedPlan.deductible?.toLocaleString() || "N/A"} · OOP Max: ${matchedPlan.oopMax?.toLocaleString() || "N/A"}
            </p>
          </div>
        ) : (
          <Tip>Start typing your plan name — we&apos;ll search our database of {">"}50,000 plans to find yours.</Tip>
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Plan type">
          <select value={planType} onChange={(e) => setPlanType(e.target.value)} className={selectClass}>
            <option value="">Select type</option>
            {PLAN_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label={<>State{!state && <span className="ml-1 text-amber-500 text-[10px] font-medium">(required)</span>}</>}>
          <select value={state} onChange={(e) => setState(e.target.value)} className={`${selectClass} ${!state ? "border-amber-300 bg-amber-50/50" : ""}`}>
            <option value="">Select state</option>
            {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Group number">
          <input
            type="text"
            value={groupNumber}
            onChange={(e) => setGroupNumber(e.target.value)}
            placeholder="e.g., A12345"
            className={inputClass}
          />
          <Tip>Labeled &quot;Group #&quot; or &quot;Grp&quot; on your card — ties your plan to your employer.</Tip>
        </Field>
        <Field label="Member ID">
          <input
            type="text"
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            placeholder="e.g., XYZ123456"
            className={inputClass}
          />
          <Tip>Your unique insurance ID — often labeled &quot;Member ID&quot; or &quot;ID #&quot;.</Tip>
        </Field>
      </div>

      <div className="flex flex-col gap-2 pt-2">
        <button
          onClick={() =>
            onContinue({ insurer, plan_type: planType, plan_name: planName, state, group_number: groupNumber, member_id: memberId, plan_source: planSource, matched_plan_id: matchedPlanId || undefined })
          }
          disabled={saving}
          className="w-full py-3 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : hasAny ? "Save & Continue →" : "Continue →"}
        </button>
        <button onClick={onSkip} className="w-full py-2.5 text-sm text-gray-400 hover:text-gray-600 transition-colors">
          Skip this step
        </button>
      </div>
    </div>
  );
}

const DollarInput = memo(function DollarInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [local, setLocal] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  // Sync from parent when value changes externally (e.g. card scan auto-fill)
  useEffect(() => { setLocal(value); }, [value]);

  return (
    <div className="relative">
      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        value={local}
        onChange={(e) => setLocal(e.target.value.replace(/[^0-9.,]/g, ""))}
        onBlur={() => {
          // Normalize: strip leading zeros, remove trailing dots/commas
          const normalized = local.replace(/,/g, "").replace(/^0+(\d)/, "$1").replace(/[.,]+$/, "");
          setLocal(normalized);
          onChange(normalized);
        }}
        placeholder={placeholder}
        className={`${inputClass} pl-7`}
      />
    </div>
  );
});

function CostsStep({
  profile,
  saving,
  onContinue,
  onSkip,
}: {
  profile: ProfileData;
  saving: boolean;
  onContinue: (data: Partial<ProfileData>) => void;
  onSkip: () => void;
}) {
  const [inDedInd, setInDedInd] = useState(profile.in_deductible_individual);
  const [inDedFam, setInDedFam] = useState(profile.in_deductible_family);
  const [inOopInd, setInOopInd] = useState(profile.in_oop_max_individual);
  const [inOopFam, setInOopFam] = useState(profile.in_oop_max_family);
  const [outDedInd, setOutDedInd] = useState(profile.out_deductible_individual);
  const [outOopInd, setOutOopInd] = useState(profile.out_oop_max_individual);
  const [copayPrimary, setCopayPrimary] = useState(profile.copay_primary);
  const [copaySpecialist, setCopaySpecialist] = useState(profile.copay_specialist);
  const [copayEr, setCopayEr] = useState(profile.copay_er);
  const [copayUrgent, setCopayUrgent] = useState(profile.copay_urgent_care);
  const [copayRx, setCopayRx] = useState(profile.copay_rx);
  const [coinsurance, setCoinsurance] = useState(profile.coinsurance_pct);

  const hasAny = inDedInd || inOopInd || copayPrimary || copaySpecialist || copayEr || coinsurance;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Your cost structure</h2>
        <p className="text-sm text-gray-500">
          These numbers let us calculate exactly how much you were actually owed.
          Find them on your Summary of Benefits, insurance card, or any EOB.
        </p>
      </div>

      {/* In-Network */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">In-Network</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Deductible (individual)">
            <DollarInput value={inDedInd} onChange={setInDedInd} placeholder="3,500" />
          </Field>
          <Field label="Deductible (family)">
            <DollarInput value={inDedFam} onChange={setInDedFam} placeholder="7,000" />
          </Field>
          <Field label="OOP max (individual)">
            <DollarInput value={inOopInd} onChange={setInOopInd} placeholder="6,250" />
          </Field>
          <Field label="OOP max (family)">
            <DollarInput value={inOopFam} onChange={setInOopFam} placeholder="12,500" />
          </Field>
        </div>
      </div>

      {/* Out-of-Network (collapsed by default) */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Out-of-Network</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Deductible (individual)">
            <DollarInput value={outDedInd} onChange={setOutDedInd} placeholder="—" />
          </Field>
          <Field label="OOP max (individual)">
            <DollarInput value={outOopInd} onChange={setOutOopInd} placeholder="—" />
          </Field>
        </div>
        <Tip>Often 2x the in-network amount. Check your SBC if unsure.</Tip>
      </div>

      {/* Copays */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Copays</h3>
        <div className="grid grid-cols-3 gap-3">
          <Field label="PCP">
            <DollarInput value={copayPrimary} onChange={setCopayPrimary} placeholder="30" />
          </Field>
          <Field label="Specialist">
            <DollarInput value={copaySpecialist} onChange={setCopaySpecialist} placeholder="60" />
          </Field>
          <Field label="ER">
            <DollarInput value={copayEr} onChange={setCopayEr} placeholder="500" />
          </Field>
          <Field label="Urgent care">
            <DollarInput value={copayUrgent} onChange={setCopayUrgent} placeholder="75" />
          </Field>
          <Field label="Rx (generic)">
            <DollarInput value={copayRx} onChange={setCopayRx} placeholder="15" />
          </Field>
          <Field label="Coinsurance">
            <div className="relative">
              <input type="text" inputMode="decimal" value={coinsurance} onChange={(e) => setCoinsurance(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="20" className={`${inputClass} pr-7`} />
              <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
            </div>
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-2 pt-2">
        <button
          onClick={() =>
            onContinue({
              in_deductible_individual: inDedInd,
              in_deductible_family: inDedFam,
              in_oop_max_individual: inOopInd,
              in_oop_max_family: inOopFam,
              out_deductible_individual: outDedInd,
              out_oop_max_individual: outOopInd,
              copay_primary: copayPrimary,
              copay_specialist: copaySpecialist,
              copay_er: copayEr,
              copay_urgent_care: copayUrgent,
              copay_rx: copayRx,
              coinsurance_pct: coinsurance,
            })
          }
          disabled={saving}
          className="w-full py-3 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : hasAny ? "Save & Continue →" : "Continue →"}
        </button>
        <button onClick={onSkip} className="w-full py-2.5 text-sm text-gray-400 hover:text-gray-600 transition-colors">
          Skip this step
        </button>
      </div>
    </div>
  );
}

function AboutYouStep({
  profile,
  saving,
  isOnboarding = false,
  onContinue,
  onSkip,
}: {
  profile: ProfileData;
  saving: boolean;
  isOnboarding?: boolean;
  onContinue: (data: Partial<ProfileData>) => void;
  onSkip: () => void;
}) {
  const [dob, setDob] = useState(profile.date_of_birth);
  const [sex, setSex] = useState(profile.sex);
  const [phoneNum, setPhoneNum] = useState(profile.phone);
  const [zipCode, setZipCode] = useState(profile.zip_code);
  const [countyFips, setCountyFips] = useState(profile.county_fips);
  const [countyName, setCountyName] = useState(profile.county_name);
  const [cityVal, setCityVal] = useState(profile.city);
  const [addr1, setAddr1] = useState(profile.address_line1);
  const [addr2, setAddr2] = useState(profile.address_line2);
  const [countyOptions, setCountyOptions] = useState<{ fips: string; name: string; state: string }[]>([]);
  const [zipResolving, setZipResolving] = useState(false);
  const hasAny = !!(dob || sex || phoneNum || zipCode);

  async function resolveZip(zip: string) {
    if (!/^\d{5}$/.test(zip)) return;
    setZipResolving(true);
    try {
      const res = await fetch(`/api/profile/resolve-county?zip=${zip}`);
      if (res.ok) {
        const { counties } = await res.json();
        if (counties && counties.length === 1) {
          setCountyFips(counties[0].fips);
          setCountyName(counties[0].name);
          setCountyOptions([]);
        } else if (counties && counties.length > 1) {
          setCountyOptions(counties);
          setCountyFips("");
          setCountyName("");
        } else {
          setCountyFips("");
          setCountyName("");
          setCountyOptions([]);
        }
      }
    } catch { /* non-critical */ }
    setZipResolving(false);
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">About you</h2>
        <p className="text-sm text-gray-500 mt-1">
          This helps us recommend age- and sex-specific benefits like cancer screenings,
          wellness visits, and preventive care you may be eligible for.
        </p>
      </div>

      <Field label="Phone number">
        <input
          type="tel"
          value={phoneNum}
          onChange={(e) => setPhoneNum(formatPhone(e.target.value))}
          placeholder="(555) 123-4567"
          className={inputClass}
        />
        <Tip>Required for account verification and important notifications about your benefits.</Tip>
      </Field>

      <Field label="Date of birth">
        <input
          type="date"
          value={dob}
          onChange={(e) => setDob(e.target.value)}
          min="1900-01-01"
          max={new Date(new Date().setFullYear(new Date().getFullYear() - 18)).toISOString().split("T")[0]}
          className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <Tip>Used to recommend age-appropriate screenings (e.g. colonoscopy at 45+, mammogram at 40+). Must be 18 or older.</Tip>
      </Field>

      <Field label="Sex assigned at birth">
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: "female", label: "Female" },
            { value: "male", label: "Male" },
            { value: "prefer_not_to_say", label: "Prefer not to say" },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSex(opt.value)}
              className={`px-3 py-2.5 text-sm font-medium rounded-xl border-2 transition-all ${
                sex === opt.value
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-gray-200 text-gray-600 hover:border-gray-300"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <Tip>Helps recommend sex-specific screenings (e.g. prostate, breast cancer, cervical).</Tip>
      </Field>

      {/* Zip code → county auto-resolution */}
      <Field label={<>Zip code <span className="text-xs text-gray-400 font-normal ml-1">(for accurate rates)</span></>} optional={false}>
        <div className="flex gap-2 items-start">
          <input
            type="text"
            inputMode="numeric"
            maxLength={5}
            value={zipCode}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 5);
              setZipCode(v);
              if (v.length === 5) resolveZip(v);
            }}
            placeholder="27601"
            className={inputClass + " max-w-[120px]"}
          />
          {zipResolving && (
            <div className="w-4 h-4 mt-2.5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          )}
          {countyName && !zipResolving && (
            <span className="mt-2.5 text-sm text-green-700 font-medium">{countyName}</span>
          )}
        </div>
        <Tip>Needed for accuracy. Insurance rates and covered services can vary by county.</Tip>
      </Field>

      {/* County disambiguation — when zip spans multiple counties */}
      {countyOptions.length > 1 && (
        <Field label="Which county?" optional={false}>
          <div className="grid grid-cols-2 gap-2">
            {countyOptions.map((c) => (
              <button
                key={c.fips}
                type="button"
                onClick={() => { setCountyFips(c.fips); setCountyName(c.name); setCountyOptions([]); }}
                className={`px-3 py-2.5 text-sm font-medium rounded-xl border-2 transition-all ${
                  countyFips === c.fips
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </Field>
      )}

      <Field label="Street address">
        <input
          type="text"
          value={addr1}
          onChange={(e) => setAddr1(e.target.value)}
          placeholder="123 Main St"
          className={inputClass}
        />
      </Field>

      <Field label="Apt / Suite / Unit">
        <input
          type="text"
          value={addr2}
          onChange={(e) => setAddr2(e.target.value)}
          placeholder="Apt 4B"
          className={inputClass}
        />
      </Field>

      <Field label="City">
        <input
          type="text"
          value={cityVal}
          onChange={(e) => setCityVal(e.target.value)}
          placeholder="Raleigh"
          className={inputClass}
        />
      </Field>

      {isOnboarding && (!phoneNum.trim() || phoneNum.replace(/\D/g, "").length < 10 || !dob) && (
        <p className="text-xs text-amber-600 bg-amber-50 p-2.5 rounded-xl">
          Phone number and date of birth are required to create your account.
        </p>
      )}

      <div className="flex flex-col gap-2 pt-2">
        <button
          onClick={() => onContinue({
            date_of_birth: dob,
            sex,
            phone: phoneNum,
            zip_code: zipCode,
            county_fips: countyFips,
            county_name: countyName,
            city: cityVal,
            address_line1: addr1,
            address_line2: addr2,
          })}
          disabled={saving || (isOnboarding && (!phoneNum.trim() || phoneNum.replace(/\D/g, "").length < 10 || !dob))}
          className="w-full py-3 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : hasAny ? "Save & Continue →" : "Continue →"}
        </button>
        {!isOnboarding && (
          <button onClick={onSkip} className="w-full py-2.5 text-sm text-gray-400 hover:text-gray-600 transition-colors">
            Skip this step
          </button>
        )}
      </div>
    </div>
  );
}

function DependentsStep({
  profile,
  saving,
  onContinue,
  onSkip,
}: {
  profile: ProfileData;
  saving: boolean;
  onContinue: (data: Partial<ProfileData>) => void;
  onSkip: () => void;
}) {
  const [deps, setDeps] = useState<Dependent[]>(() => {
    try { return JSON.parse(profile.dependents || "[]"); }
    catch { return []; }
  });

  function addDependent() {
    setDeps([...deps, { name: "", relationship: "child", date_of_birth: "", sex: "", on_same_plan: true }]);
  }

  function updateDep(idx: number, field: keyof Dependent, value: string | boolean) {
    setDeps(deps.map((d, i) => i === idx ? { ...d, [field]: value } : d));
  }

  function removeDep(idx: number) {
    setDeps(deps.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Family &amp; dependents</h2>
        <p className="text-sm text-gray-500 mt-1">
          Adding family members on your plan helps us surface relevant benefits like
          pediatric care, maternity coverage, and family deductible tracking.
        </p>
      </div>

      {deps.length === 0 ? (
        <div className="p-6 border-2 border-dashed border-gray-200 rounded-2xl text-center">
          <p className="text-sm text-gray-500">No dependents added yet.</p>
          <button
            onClick={addDependent}
            className="mt-3 px-4 py-2 text-sm font-semibold text-blue-600 border border-blue-200 rounded-xl hover:bg-blue-50 transition-colors"
          >
            + Add a family member
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {deps.map((dep, idx) => (
            <div key={idx} className="p-4 bg-gray-50 rounded-2xl space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  {dep.relationship === "spouse" || dep.relationship === "partner" ? "Partner" : dep.relationship === "child" ? "Child" : "Dependent"} {idx + 1}
                </span>
                <button onClick={() => removeDep(idx)} className="text-xs text-red-400 hover:text-red-600">
                  Remove
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Name</label>
                  <input
                    value={dep.name}
                    onChange={(e) => updateDep(idx, "name", e.target.value)}
                    placeholder="First name"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Relationship</label>
                  <select
                    value={dep.relationship}
                    onChange={(e) => updateDep(idx, "relationship", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="spouse">Spouse</option>
                    <option value="partner">Partner</option>
                    <option value="child">Child</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Date of birth</label>
                  <input
                    type="date"
                    value={dep.date_of_birth}
                    onChange={(e) => updateDep(idx, "date_of_birth", e.target.value)}
                    max={new Date().toISOString().split("T")[0]}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Sex</label>
                  <select
                    value={dep.sex}
                    onChange={(e) => updateDep(idx, "sex", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">—</option>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={dep.on_same_plan}
                  onChange={(e) => updateDep(idx, "on_same_plan", e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-600">On my insurance plan</span>
              </label>
            </div>
          ))}

          <button
            onClick={addDependent}
            className="w-full py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm font-medium text-gray-500 hover:border-blue-300 hover:text-blue-600 transition-colors"
          >
            + Add another
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2 pt-2">
        <button
          onClick={() => onContinue({ dependents: JSON.stringify(deps) })}
          disabled={saving}
          className="w-full py-3 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : deps.length > 0 ? "Save & Continue →" : "Continue →"}
        </button>
        <button onClick={onSkip} className="w-full py-2.5 text-sm text-gray-400 hover:text-gray-600 transition-colors">
          {deps.length === 0 ? "No dependents — skip" : "Skip this step"}
        </button>
      </div>
    </div>
  );
}

function ConcernStep({
  profile,
  saving,
  isOnboarding,
  isLastStep,
  savedGlobal,
  onContinue,
  onSkip,
}: {
  profile: ProfileData;
  saving: boolean;
  isOnboarding: boolean;
  isLastStep: boolean;
  savedGlobal: boolean;
  onContinue: (data: Partial<ProfileData>) => void;
  onSkip: () => void;
}) {
  const [concern, setConcern] = useState(profile.primary_concern);

  const doneLabel = isOnboarding ? "Finish & Upload Documents →" : "Save Profile";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">What brings you here?</h2>
        <p className="text-sm text-gray-500">
          Tell us briefly what happened. This helps us prioritize the right audit checks for your situation.
        </p>
      </div>

      <Field label="Your situation">
        <textarea
          value={concern}
          onChange={(e) => setConcern(e.target.value)}
          placeholder="e.g., I got a $4,200 ER bill after my insurance paid, and the EOB doesn't match what the hospital billed…"
          rows={4}
          className={inputClass}
        />
        <Tip>No pressure — even a brief description helps. You can always update this later.</Tip>
      </Field>

      {savedGlobal && (
        <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-100 rounded-xl">
          <svg className="w-4 h-4 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          <p className="text-sm text-green-700 font-medium">Profile saved.</p>
        </div>
      )}

      <div className="flex flex-col gap-2 pt-2">
        <button
          onClick={() => onContinue({ primary_concern: concern })}
          disabled={saving}
          className="w-full py-3 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : doneLabel}
        </button>
        {isOnboarding && (
          <button onClick={onSkip} className="w-full py-2.5 text-sm text-gray-400 hover:text-gray-600 transition-colors">
            Skip — go to upload
          </button>
        )}
      </div>

      {!isOnboarding && (
        <Link href="/dashboard" className="block text-center text-xs text-gray-400 hover:text-gray-600">
          ← Back to dashboard
        </Link>
      )}
    </div>
  );
}

// ─── Read-only profile helpers ───────────────────────────────────────────────

function ProfileSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-5 bg-white border border-gray-100 rounded-2xl">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        {children}
      </div>
    </div>
  );
}

function ProfileField({ label, value, prefix, suffix }: { label: string; value: string; prefix?: string; suffix?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-gray-400">{label}</p>
      {value ? (
        <p className="text-sm font-medium text-gray-900 break-words">{prefix}{value}{suffix}</p>
      ) : (
        <p className="text-sm text-gray-300 italic">Not set</p>
      )}
    </div>
  );
}
