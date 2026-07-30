/**
 * Dev-only preview of the three plan-identity prompt states (S292 item 4).
 *
 * These render only after a real upload, behind `plan_identity_resolver_v1`,
 * on an authenticated page — so without this the copy could not be reviewed
 * without staging three different parse outcomes against a live account.
 *
 * Renders the REAL `ParseTerminalView` variants, not mock-ups, so what is
 * approved here is what ships.
 */
"use client";

import { notFound } from "next/navigation";
import { ParseTerminalView } from "@/components/parsing/ParseTerminalView";

const noop = async () => {};

export default function PlanIdentityPromptsPreview() {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <main className="mx-auto max-w-2xl bg-[#fafafa] p-10">
      <h1 className="mb-2 text-xl font-bold">Plan identity — the three prompt states</h1>
      <p className="mb-8 text-sm text-gray-600">
        Verdicts from <code>resolvePlanIdentity</code>. Only <strong>same</strong> merges; the other
        two hold the upload as an inactive plan and ask.
      </p>

      <section className="mb-10">
        <h2 className="mb-2 text-sm font-semibold text-gray-500">
          1 — MATCHED (verdict <code>same</code>) · the merge already happened, so this is a receipt
        </h2>
        <ParseTerminalView
          variant="identity_matched"
          match={{
            existingPlanId: "plan-1",
            existingPlanName: "UnitedHealthcare Choice Plus",
          }}
          submitting={false}
          fileName="2026-SBC.pdf"
          onUploadAnother={() => {}}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-2 text-sm font-semibold text-gray-500">
          1b — MATCHED with the 4C escape hatch wired (hidden until the unwind exists)
        </h2>
        <ParseTerminalView
          variant="identity_matched"
          match={{
            existingPlanId: "plan-1",
            existingPlanName: "UnitedHealthcare Choice Plus",
          }}
          submitting={false}
          onNotMyPlan={noop}
          fileName="2026-SBC.pdf"
          onUploadAnother={() => {}}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-2 text-sm font-semibold text-gray-500">
          2 — DIFFERENT (verdict <code>different</code>) · body is the resolver&apos;s own sentence
        </h2>
        <ParseTerminalView
          variant="mismatch"
          mismatch={{
            type: "insurer",
            existingInsurer: "Cigna",
            parsedInsurer: "Aetna",
            identity: {
              verdict: "different",
              reason: "insurer_differs",
              evidence: "This document is from Aetna, not Cigna.",
            },
          }}
          submitting={false}
          onUseThisPlan={noop}
          onKeepCurrent={noop}
          fileName="aetna-sbc.pdf"
          onUploadAnother={() => {}}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-2 text-sm font-semibold text-gray-500">
          2b — DIFFERENT, legacy path (flag OFF — no resolver, no evidence line)
        </h2>
        <ParseTerminalView
          variant="mismatch"
          mismatch={{ type: "insurer", existingInsurer: "Cigna", parsedInsurer: "Aetna" }}
          submitting={false}
          onUseThisPlan={noop}
          onKeepCurrent={noop}
          fileName="aetna-sbc.pdf"
          onUploadAnother={() => {}}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-2 text-sm font-semibold text-gray-500">
          3 — UNCERTAIN (verdict <code>uncertain</code>) · held and asked, never silently merged
        </h2>
        <ParseTerminalView
          variant="identity_uncertain"
          mismatch={{
            existingPlanName: "Cigna Open Access Plus",
            identity: {
              verdict: "uncertain",
              reason: "insufficient_signal",
              evidence: "We couldn't tell from the document whether this is the same plan.",
              existingPlanName: "Cigna Open Access Plus",
            },
          }}
          submitting={false}
          onSamePlan={noop}
          onDifferentPlan={noop}
          fileName="scanned-plan.pdf"
          onUploadAnother={() => {}}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-2 text-sm font-semibold text-gray-500">
          3b — UNCERTAIN with no plan name on file (fallback copy)
        </h2>
        <ParseTerminalView
          variant="identity_uncertain"
          mismatch={{ identity: { verdict: "uncertain", reason: "insufficient_signal" } }}
          submitting={false}
          onSamePlan={noop}
          onDifferentPlan={noop}
          fileName="scanned-plan.pdf"
          onUploadAnother={() => {}}
        />
      </section>
    </main>
  );
}
