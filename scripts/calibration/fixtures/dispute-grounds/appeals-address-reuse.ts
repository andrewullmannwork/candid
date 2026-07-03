/**
 * appeals-address-reuse — dispute-letters v2 Zone-3 (S266) unit fixture.
 *
 * Locks pickReusableAppealsOverride: match by insurerId equality OR normalized
 * insurer name, require a complete address, most-recent confirmedAt wins. Guards
 * the cross-dispute appeals-address reuse overlay (a user's supplied address auto-
 * carries to their other same-insurer disputes; Pattern 1 #14).
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/appeals-address-reuse.ts
 */
import {
  pickReusableAppealsOverride,
  type InsurerAddressOverride,
} from "../../../../src/lib/disputes/plan-context";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (${String(got)})` : ""}`);
}

function ov(partial: Partial<InsurerAddressOverride>): InsurerAddressOverride {
  return {
    insurerId: null,
    insurerName: null,
    addressLine1: "1 Appeals Way",
    addressLine2: null,
    city: "Hartford",
    state: "CT",
    postalCode: "06101",
    phone: null,
    confirmedAt: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
}

// ── id match ─────────────────────────────────────────────────────────────────
check(
  "id · exact insurerId match",
  pickReusableAppealsOverride({ id: "ins-1", name: null }, [ov({ insurerId: "ins-1" })])?.insurerId === "ins-1",
);
check(
  "id · different insurerId → no match",
  pickReusableAppealsOverride({ id: "ins-1", name: null }, [ov({ insurerId: "ins-2" })]) === null,
);

// ── name match (normalized) ──────────────────────────────────────────────────
check(
  "name · exact normalized match",
  pickReusableAppealsOverride({ id: null, name: "Aetna" }, [ov({ insurerName: "Aetna" })]) !== null,
);
check(
  "name · Inc/punctuation normalized away",
  pickReusableAppealsOverride({ id: null, name: "Aetna, Inc." }, [ov({ insurerName: "AETNA inc" })]) !== null,
);
check(
  "name · different insurer → no match",
  pickReusableAppealsOverride({ id: null, name: "Aetna" }, [ov({ insurerName: "Cigna" })]) === null,
);
check(
  "name · id mismatch but name match → matches (name is a fallback key)",
  pickReusableAppealsOverride({ id: "ins-1", name: "Aetna" }, [ov({ insurerId: "ins-9", insurerName: "Aetna" })]) !== null,
);

// ── completeness guard ───────────────────────────────────────────────────────
check(
  "complete · missing addressLine1 → rejected",
  pickReusableAppealsOverride({ id: "ins-1", name: null }, [ov({ insurerId: "ins-1", addressLine1: "" })]) === null,
);
check(
  "complete · missing postalCode → rejected",
  pickReusableAppealsOverride({ id: "ins-1", name: null }, [ov({ insurerId: "ins-1", postalCode: "" })]) === null,
);

// ── recency: most-recent confirmedAt wins ────────────────────────────────────
{
  const older = ov({ insurerId: "ins-1", addressLine1: "OLD", confirmedAt: "2026-01-01T00:00:00.000Z" });
  const newer = ov({ insurerId: "ins-1", addressLine1: "NEW", confirmedAt: "2026-06-15T00:00:00.000Z" });
  check(
    "recency · newer confirmedAt wins (order A)",
    pickReusableAppealsOverride({ id: "ins-1", name: null }, [older, newer])?.addressLine1 === "NEW",
  );
  check(
    "recency · newer confirmedAt wins (order B)",
    pickReusableAppealsOverride({ id: "ins-1", name: null }, [newer, older])?.addressLine1 === "NEW",
  );
}

// ── no key / no candidates ───────────────────────────────────────────────────
check(
  "guard · no current id AND no name → null",
  pickReusableAppealsOverride({ id: null, name: null }, [ov({ insurerId: "ins-1" })]) === null,
);
check("guard · empty candidates → null", pickReusableAppealsOverride({ id: "ins-1", name: "Aetna" }, []) === null);
check(
  "guard · whitespace-only name is not a key on its own",
  pickReusableAppealsOverride({ id: null, name: "   " }, [ov({ insurerName: "   " })]) === null,
);

// ── mixed pool: picks the matching complete one ──────────────────────────────
{
  const pool = [
    ov({ insurerName: "Cigna" }),
    ov({ insurerId: "ins-7", insurerName: "Aetna", addressLine1: "WANT", confirmedAt: "2026-05-01T00:00:00.000Z" }),
    ov({ insurerName: "Aetna", addressLine1: "" }), // incomplete
  ];
  check(
    "mixed · picks the complete Aetna match",
    pickReusableAppealsOverride({ id: null, name: "Aetna" }, pool)?.addressLine1 === "WANT",
  );
}

console.log(`\nappeals-address-reuse fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
