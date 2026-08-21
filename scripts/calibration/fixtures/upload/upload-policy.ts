/**
 * S322 — UPLOAD POLICY FIXTURE (pure, offline, CI-wired).
 *
 * Locks the ONE client-side upload-limit derivation that replaced five
 * hardcoded ceilings (20MB ×3, 25MB ×2). The contract under test:
 *
 *   - type gate = server's accepted formats (mime allowlist + HEIC-by-name)
 *   - size ceiling derives from the LIVE limits, never a constant:
 *       direct ON  → the admin-tuned flag value
 *       direct OFF → min(flag, LEGACY_SAFE_MAX_BYTES) — the honest ceiling,
 *         because bodies over ~4.5MB die at Vercel's edge (probed live at
 *         S322: 9MB/29MB POSTs → 413 FUNCTION_PAYLOAD_TOO_LARGE)
 *   - the user-facing message carries the derived number ("File must be
 *     under NMB.") — a copy string that can never disagree with the check
 *   - fallback (limits endpoint unreachable) fails toward the conservative
 *     legacy ceiling with direct OFF
 *
 * Offline: pure functions only. No DB, no network, no env.
 */
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  FALLBACK_UPLOAD_LIMITS,
  LEGACY_SAFE_MAX_BYTES,
  effectiveClientMaxBytes,
  isAllowedUploadFile,
  uploadSizeErrorMessage,
  UPLOAD_TYPE_ERROR_MESSAGE,
  validateUploadFile,
} from "@/lib/upload/upload-policy";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}`);
  }
}

const MB = 1024 * 1024;

console.log("— type gate mirrors the server's accepted formats —");
check("pdf mime allowed", isAllowedUploadFile("bill.pdf", "application/pdf"));
check("jpeg mime allowed", isAllowedUploadFile("card.jpg", "image/jpeg"));
check("png mime allowed", isAllowedUploadFile("card.png", "image/png"));
check("heic by NAME with empty mime allowed", isAllowedUploadFile("IMG_0042.HEIC", ""));
check("exe rejected", !isAllowedUploadFile("virus.exe", "application/octet-stream"));
check("allowlist unchanged (5 formats)", ALLOWED_UPLOAD_MIME_TYPES.length === 5);

console.log("— size message derives from the limit —");
check("30MB message", uploadSizeErrorMessage(30 * MB) === "File must be under 30MB.");
check("4MB message", uploadSizeErrorMessage(LEGACY_SAFE_MAX_BYTES) === "File must be under 4MB.");

console.log("— effective client ceiling —");
check(
  "direct ON → admin flag value",
  effectiveClientMaxBytes({ maxFileSizeBytes: 30 * MB, directUploadEnabled: true }) === 30 * MB,
);
check(
  "direct OFF → capped at the platform-safe legacy ceiling",
  effectiveClientMaxBytes({ maxFileSizeBytes: 30 * MB, directUploadEnabled: false }) ===
    LEGACY_SAFE_MAX_BYTES,
);
check(
  "direct OFF + flag BELOW the platform ceiling → flag wins",
  effectiveClientMaxBytes({ maxFileSizeBytes: 2 * MB, directUploadEnabled: false }) === 2 * MB,
);

console.log("— validateUploadFile —");
const direct30 = { maxFileSizeBytes: 30 * MB, directUploadEnabled: true };
check(
  "exact-limit file passes (strict > like the legacy check)",
  validateUploadFile({ name: "big.pdf", type: "application/pdf", size: 30 * MB }, direct30) === null,
);
check(
  "limit+1 rejected with the derived message",
  validateUploadFile({ name: "big.pdf", type: "application/pdf", size: 30 * MB + 1 }, direct30) ===
    "File must be under 30MB.",
);
check(
  "bad type outranks size",
  validateUploadFile({ name: "virus.exe", type: "application/zip", size: 31 * MB }, direct30) ===
    UPLOAD_TYPE_ERROR_MESSAGE,
);
check(
  "direct OFF: 20MB pdf honestly rejected at the legacy ceiling",
  validateUploadFile(
    { name: "scan.pdf", type: "application/pdf", size: 20 * MB },
    { maxFileSizeBytes: 30 * MB, directUploadEnabled: false },
  ) === "File must be under 4MB.",
);

console.log("— fallback fails conservative —");
check(
  "fallback = legacy ceiling + direct OFF",
  FALLBACK_UPLOAD_LIMITS.maxFileSizeBytes === LEGACY_SAFE_MAX_BYTES &&
    FALLBACK_UPLOAD_LIMITS.directUploadEnabled === false,
);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.error("FAILED:", fails.join(" | "));
  process.exit(1);
}
