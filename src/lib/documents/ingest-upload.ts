/**
 * S322 — the ONE document-upload ingest pipeline, extracted VERBATIM from
 * /api/documents/upload so the direct-to-storage doors (upload-start +
 * upload-complete) and the legacy body-POST door share every gate instead of
 * growing two diverging copies.
 *
 * Three thin doors, one pipeline:
 *   POST /api/documents/upload           — legacy: bytes in the request body
 *                                          (≤ Vercel's ~4.5MB edge cap)
 *   POST /api/documents/upload-start     — direct: preflight + caps + signed URL
 *   POST /api/documents/upload-complete  — direct: bytes already in storage;
 *                                          download → same pipeline
 *
 * Stage map (order preserved exactly from the pre-S322 route):
 *   preflight  — users row → chd_erased_at gate → consent → Turnstile
 *   caps       — stale-doc recovery sweeps → per-user cap → daily cap (CF-36 exempt)
 *   ingest     — HEIC→JPEG → SHA-256 hash → blocklist → hash dedup →
 *                storage ensure → documents INSERT → purpose → quick-classify →
 *                page cap → doc-type resolver → confirmation halt →
 *                hash rate limit → confidence-tiered dispatch
 *
 * Only four operations ever need the raw bytes (HEIC convert, hash, storage
 * write, quick-classify) — everything else is DB + JSON, which is what makes
 * the direct path safe: the doors differ ONLY in how bytes arrive.
 */

import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { quickClassify } from "@/lib/classifier/quick-classify";
import { notifyAdminForReview, notifyUserPendingReview } from "@/lib/notifications";
import { enqueueChunk } from "@/lib/queue/qstash";
import { matchInsurerCatalog } from "@/lib/plan/insurer-match";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { verifyTurnstileToken, getRemoteIp } from "@/lib/security/turnstile";
import { computeFileHash } from "@/lib/plan/extraction-dedup";
import { isHashBlocked } from "@/lib/security/file-hash-blocklist";

// CF-36 (Session 72) — test account exemption from per-user document caps.
// Hardcoded single-account escape hatch so MVP testing iterations aren't
// blocked by upload limits. Revisit at OPS Sprint pre-OPS.1 to convert to a
// proper admin role + flag (Phase 2 follow-up).
const TEST_EXEMPT_EMAIL = "andrew.david.ullmann@gmail.com";

function isTestExemptUser(email: string | null | undefined): boolean {
  return email?.toLowerCase() === TEST_EXEMPT_EMAIL;
}

/**
 * Cost-H (S267) — resolve the async-ingestion UX tier for an auto-processed
 * upload. Extracted so the HIGH- and MEDIUM-confidence auto-process paths AND
 * the doc-type-confirmation path emit the SAME { isLargeDoc, willEmail } signal.
 * The S198 "medium-conf FIRING-GAP" was exactly this drift: a path omitted the
 * tier, so a large doc landing that path got a blind wait (no splash) while the
 * completion email/banner still fired on their own page gates. One definition =
 * the paths can't diverge again.
 */
async function resolveUploadAsyncTier(
  pageCount: number,
  contentType: string,
  userEmail: string,
): Promise<{ isLargeDoc: boolean; willEmail: boolean }> {
  const asyncIngestionEnabled = await isFeatureEnabled("async_ingestion_ux_v1", userEmail);
  const { getFlags, classifyAsyncDocTier } = await import("@/lib/config/feature-flags");
  const { ASYNC_REDIRECT_MAX_PAGES, ASYNC_EMAIL_MAX_PAGES } = await getFlags();
  return classifyAsyncDocTier({
    pageCount,
    isPdf: contentType === "application/pdf",
    asyncEnabled: asyncIngestionEnabled,
    redirectMaxPages: ASYNC_REDIRECT_MAX_PAGES,
    emailMaxPages: ASYNC_EMAIL_MAX_PAGES,
  });
}

/** Vercel-aware origin for QStash callback URLs (verbatim from the route). */
export function deriveBaseUrl(req: NextRequest): string {
  return req.headers.get("x-forwarded-proto") && req.headers.get("x-forwarded-host")
    ? `${req.headers.get("x-forwarded-proto")}://${req.headers.get("x-forwarded-host")}`
    : new URL(req.url).origin;
}

export interface UploadUserContext {
  user: { id: string; created_at: string | null };
  email: string;
  consentEventId: string;
  exemptFromCaps: boolean;
}

export type PreflightResult =
  | { ok: true; ctx: UploadUserContext }
  | { ok: false; response: NextResponse };

/**
 * Auth-adjacent gates every door runs before touching bytes: users row →
 * chd_erased_at → consent → Turnstile (with the S320 session-established
 * acceptance). `requireTurnstile: false` is for upload-complete only — the
 * human check already ran at upload-start, and re-challenging between the PUT
 * and the finalize would be exactly the per-step friction #305 removed.
 */
export async function runUploadPreflight(args: {
  supabase: SupabaseClient;
  req: NextRequest;
  decoded: { uid: string; email?: string | null };
  turnstileToken: string | undefined;
  requireTurnstile: boolean;
}): Promise<PreflightResult> {
  const { supabase, req, decoded, turnstileToken, requireTurnstile } = args;

  // Get internal user ID (created_at feeds the S320 session-established
  // Turnstile acceptance below)
  const { data: user } = await supabase
    .from("users")
    .select("id, chd_erased_at, created_at")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "User not found" }, { status: 404 }) };
  }

  // Re-block uploads after a health-data erasure (mig 166). The consent check
  // below filters granted=true and revoke keeps consent_events, so the old grant
  // row would otherwise still satisfy it. chd_erased_at is cleared on re-grant,
  // so a returning user who re-consents can upload again.
  if (user.chd_erased_at) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Health data consent is required." }, { status: 403 }),
    };
  }

  // Check consent
  const { data: consentEvent } = await supabase
    .from("consent_events")
    .select("id")
    .eq("user_id", user.id)
    .eq("consent_type", "health_data_upload")
    .eq("granted", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!consentEvent) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Health data consent is required." }, { status: 403 }),
    };
  }

  // Turnstile gate (S68 mig 075). Authenticated route, but bot defense still
  // matters: a compromised account or spammy authenticated client can burn
  // OCR/Haiku budget without it.
  //
  // S320 session-established acceptance: every account is born through a
  // Turnstile-verified sync, so when the flag's config enables it, a session
  // younger than the TTL passes without a fresh per-call token (one challenge
  // at the front door, not one per step). Config absent → per-call tokens,
  // byte-identical to pre-S320. The 403 carries code "turnstile_required" so
  // the client can mount the widget and retry once instead of dead-ending.
  if (requireTurnstile) {
    const turnstileEnforced = await isFeatureEnabled("turnstile_enforcement_v1");
    if (turnstileEnforced) {
      const verify = await verifyTurnstileToken(turnstileToken, getRemoteIp(req));
      if (!verify.success) {
        const { resolveTurnstileSessionConfig, isTurnstileSessionEstablished } = await import(
          "@/lib/security/turnstile"
        );
        const { data: tsFlag } = await supabase
          .from("feature_flag_rules")
          .select("config")
          .eq("flag_key", "turnstile_enforcement_v1")
          .maybeSingle();
        const sessionCfg = resolveTurnstileSessionConfig(tsFlag?.config);
        if (isTurnstileSessionEstablished(user.created_at, sessionCfg)) {
          console.log(
            "[upload] turnstile: session-established acceptance for user=" + user.id,
          );
        } else {
          console.warn(
            "[upload] Turnstile verification failed for user=" + user.id +
              ", errors=" + JSON.stringify(verify.errorCodes ?? []),
          );
          return {
            ok: false,
            response: NextResponse.json(
              {
                error: "Bot defense check failed. Please reload and try again.",
                code: "turnstile_required",
              },
              { status: 403 },
            ),
          };
        }
      }
    }
  }

  const exemptFromCaps = isTestExemptUser(decoded.email);
  if (exemptFromCaps) {
    console.log("[upload] CF-36 test-account cap exemption applied for", decoded.email);
  }

  return {
    ok: true,
    ctx: {
      user: { id: user.id as string, created_at: (user.created_at as string | null) ?? null },
      email: decoded.email || "",
      consentEventId: consentEvent.id as string,
      exemptFromCaps,
    },
  };
}

/**
 * Stale-doc recovery sweeps + per-user cap + daily cap (verbatim order from
 * the route — the sweep runs FIRST so long-stuck docs flip to `error` and
 * leave the cap count's status whitelist). Returns null when clear, or the
 * rejection response.
 */
export async function enforceUploadCapsAndSweeps(
  supabase: SupabaseClient,
  ctx: UploadUserContext,
): Promise<NextResponse | null> {
  // Recover stuck documents — reset any "processing" docs older than 5 min
  // OR "queued" docs older than 10 min (longer threshold for queued because
  // QStash delivery has built-in retries; we wait longer before declaring
  // stuck) to "error". Per S74.5c C-7 — closes the dedup-to-stuck-queued
  // gap where §1.6's whitelist would otherwise return an infinitely-pending
  // doc on re-upload.
  await supabase
    .from("documents")
    .update({ status: "error", processing_error: "Processing timed out. Please try uploading again." })
    .eq("user_id", ctx.user.id)
    .eq("status", "processing")
    .lt("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());
  await supabase
    .from("documents")
    .update({ status: "error", processing_error: "Processing did not start in time. Please try uploading again." })
    .eq("user_id", ctx.user.id)
    .eq("status", "queued")
    .lt("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  // CF-36: test account is exempt from both per-user and daily caps.
  if (ctx.exemptFromCaps) return null;

  const { getFlags } = await import("@/lib/config/feature-flags");
  const flags = await getFlags();

  // Check per-user document limit (exclude errored/failed docs and card scan audit trail)
  const { count: userDocCount } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ctx.user.id)
    .neq("doc_type", "insurance_card")
    .in("status", ["uploaded", "queued", "processing", "processed"]);

  if (userDocCount != null && userDocCount >= flags.UPLOAD_MAX_PER_USER) {
    return NextResponse.json(
      { error: `You've reached the upload limit of ${flags.UPLOAD_MAX_PER_USER} documents. Contact support if you need more.` },
      { status: 429 }
    );
  }

  // Daily upload cap — 10 uploads per calendar day (excludes card scan audit trail)
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const { count: todayCount } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ctx.user.id)
    .neq("doc_type", "insurance_card")
    .gte("created_at", dayStart.toISOString());

  const DAILY_UPLOAD_LIMIT = parseInt(process.env.DAILY_UPLOAD_LIMIT || "10", 10);
  if (todayCount != null && todayCount >= DAILY_UPLOAD_LIMIT) {
    return NextResponse.json(
      { error: `You've reached the daily upload limit of ${DAILY_UPLOAD_LIMIT} documents. Try again tomorrow.` },
      { status: 429 }
    );
  }

  return null;
}

export interface IngestArgs {
  supabase: SupabaseClient;
  req: NextRequest;
  ctx: UploadUserContext;
  buffer: Buffer;
  fileName: string;
  /** Size the user's file claimed on disk (pre-HEIC-convert) — persisted to the row. */
  originalSize: number;
  contentType: string;
  ext: string;
  isHeicInput: boolean;
  docType: string;
  purpose: "primary" | "comparison";
  documentId: string;
  /**
   * Direct door only: the object the client already PUT via signed URL.
   * Pre-insert rejects (blocklist / dedup short-circuit) remove it so
   * rejected bytes never linger in storage; when the final path differs
   * (HEIC→JPEG), the converted object replaces it. Legacy door: undefined —
   * ingest performs the storage write itself, after the same gates.
   */
  existingObjectPath?: string;
}

/** Stage B + C — verbatim pipeline from the pre-S322 route. */
export async function ingestDocumentBytes(args: IngestArgs): Promise<NextResponse> {
  const { supabase, req, ctx } = args;
  let { buffer, contentType, ext, docType } = args;
  const { fileName, originalSize, purpose, documentId, existingObjectPath } = args;
  const decodedEmail = ctx.email;

  // B12 — HEIC→JPEG conversion at upload time. Document AI doesn't support HEIC
  // natively, and the downstream process-chunk pipeline hardcoded application/pdf
  // for years which meant HEIC uploads silently failed at OCR. Converting here
  // keeps storage clean (always JPEG/PDF) and lets process-chunk's image branch
  // treat all inbound images uniformly. Mirrors the scan-card route's HEIC
  // handling (scan-card/route.ts:401-413) — pure-JS heic-convert, no native
  // deps, works on Vercel serverless.
  if (args.isHeicInput || contentType === "image/heic" || contentType === "image/heif") {
    try {
      const heicConvert = (await import("heic-convert")).default;
      const jpegBuffer = await heicConvert({
        buffer: new Uint8Array(buffer),
        format: "JPEG",
        quality: 0.9,
      });
      buffer = Buffer.from(jpegBuffer);
      contentType = "image/jpeg";
      ext = "jpg";
      console.log("[upload] HEIC→JPEG conversion OK, size:", buffer.length);
    } catch (convErr) {
      console.error("[upload] HEIC conversion failed:", convErr);
      if (existingObjectPath) {
        await supabase.storage.from("documents").remove([existingObjectPath]).then(
          (r) => r.error && console.warn("[upload] cleanup after HEIC failure:", r.error.message),
        );
      }
      return NextResponse.json(
        { error: "Could not process HEIC image. Try taking a screenshot or converting to JPEG first." },
        { status: 400 }
      );
    }
  }

  const storagePath = `${ctx.user.id}/${documentId}.${ext}`;

  // Direct-door cleanup for any reject that happens before the documents row
  // exists (blocklist hit, promoted-canonical dedup). The legacy door has
  // nothing to clean — its gates run before the storage write, and that order
  // is preserved below.
  const preInsertCleanup = async () => {
    if (!existingObjectPath) return;
    const targets = existingObjectPath === storagePath
      ? [existingObjectPath]
      : [existingObjectPath, storagePath];
    const { error } = await supabase.storage.from("documents").remove(targets);
    if (error) console.warn("[upload] pre-insert object cleanup failed:", error.message);
  };

  // S74.5 D11 (Session 83) — ingestion-layer file-hash dedup. Compute SHA-256
  // of the file bytes; if (user_id, file_hash) already exists in documents,
  // short-circuit and return the existing documentId. This prevents the
  // duplicate-claims pipeline that motivated D11 from re-firing whenever a
  // user re-uploads the same PDF. Hash is computed in-memory (file already
  // loaded for storage upload anyway), so the check has zero extra IO.
  // Comparison-purpose uploads are EXCLUDED from dedup — by design those
  // intentionally upload alternate plan docs that may share filenames or
  // even bytes if the user copies one comparison to another slot; the
  // /compare flow needs distinct documents rows per slot.
  const fileHash = computeFileHash(buffer);

  // Ing-G.4 — admin-curated file_hash_blocklist kill-switch (mig 119). Reject
  // before storage write + classifier call so blocked hashes burn zero OCR/
  // Haiku budget. Forward-only semantics: existing documents rows with this
  // hash are unaffected. Opaque user-facing message — deliberately doesn't
  // reveal the block reason (denies adversary feedback signal).
  if (await isHashBlocked(supabase, fileHash)) {
    console.warn(
      `[upload] blocklist hit: hash=${fileHash.slice(0, 8)}… user=${ctx.user.id}`,
    );
    await preInsertCleanup();
    return NextResponse.json(
      { error: "This document can't be processed. If you believe this is an error, contact support." },
      { status: 403 },
    );
  }

  if (purpose !== "comparison") {
    // S74.5c §1.6 — only dedup against docs that have actually entered the
    // processing pipeline. `uploaded` is the limbo state before quick-classify
    // wires the doc up; if a prior upload got stuck there (transient classify
    // failure, server crash mid-flight, etc.), deduping to it leaves the user
    // staring at an infinite spinner. The recovery block in
    // enforceUploadCapsAndSweeps already auto-resets long-stuck `processing`
    // docs to `error`, which correctly excludes them from this whitelist via
    // the .in() filter.
    const { data: existingDoc } = await supabase
      .from("documents")
      .select("id, doc_type, status, file_name, created_at")
      .eq("user_id", ctx.user.id)
      .eq("file_hash", fileHash)
      .in("status", ["queued", "processing", "processed"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingDoc) {
      // S93 Bug C fix — gate dedup on canonical promotion state.
      //
      // Old behavior: any same-user same-hash match in [queued, processing,
      // processed] short-circuited the upload. This blocked re-uploads from
      // contributing to the promotion flywheel — Pattern 1 #3 distinct-user
      // corroboration count never grew past whatever it had on first parse,
      // and CF-40 v3 canonical_document_stability counter never accrued
      // additional parse votes for hash convergence.
      //
      // New behavior per Andrew direction (S93): "If the hash already exists
      // it should either load again and contribute to the promotion flywheel
      // or if already promoted, it should skip." Translated to code:
      //   - canonical promoted (verification_count >= 3) → DEDUP, return
      //     existing doc, frontend jumps to results (Bug A handles UX)
      //   - NOT promoted → fall through to new INSERT + parse, contributing
      //     to canonical_document_stability counter (CF-40 v3) on this parse
      //     and to Pattern 1 #3 distinct-user count when the upload comes
      //     from a distinct user.
      //
      // Resolves the canonical via insurance_plans.source_document_id
      // (mig 009) → canonical_plans.verification_count (mig 066). When the
      // existing doc has no canonical link yet (parse pending or failed),
      // canonicalPromoted defaults to false → re-parse allowed.
      const PROMOTION_THRESHOLD = 3; // Pattern 1 #3 distinct-user threshold
      let canonicalPromoted = false;
      const { data: linkedPlan } = await supabase
        .from("insurance_plans")
        .select("canonical_plan_id")
        .eq("source_document_id", existingDoc.id)
        .not("canonical_plan_id", "is", null)
        .limit(1)
        .maybeSingle();
      if (linkedPlan?.canonical_plan_id) {
        const { data: canon } = await supabase
          .from("canonical_plans")
          .select("verification_count")
          .eq("id", linkedPlan.canonical_plan_id)
          .maybeSingle();
        const count = (canon?.verification_count as number | null) ?? 0;
        canonicalPromoted = count >= PROMOTION_THRESHOLD;
      }

      if (canonicalPromoted) {
        console.log(
          `[upload] file-hash dedup hit on PROMOTED canonical — reusing documentId ${existingDoc.id} for user ${ctx.user.id}`,
        );
        await preInsertCleanup();
        return NextResponse.json({
          documentId: existingDoc.id as string,
          status: existingDoc.status as string,
          deduplicated: true,
          deduplicationReason: "canonical_promoted",
          existingFileName: existingDoc.file_name as string,
        });
      }

      console.log(
        `[upload] file-hash dedup hit on NON-promoted canonical — allowing re-parse to contribute to flywheel (existing doc: ${existingDoc.id})`,
      );
      // Fall through to new INSERT + parse. The downstream CF-40 v3
      // canonical_document_stability per-(canonical, hash) counter will
      // accrue another parse vote on this attempt; Pattern 1 #3 distinct-user
      // corroboration count grows when the upload comes from a different
      // user_id than the existing doc.
    }
  }

  // Ensure the object sits at the final storage path.
  //  - legacy door: upload the buffer (verbatim pre-S322 behavior).
  //  - direct door, same path: bytes already there — skip the write.
  //  - direct door, HEIC: upload the converted JPEG, remove the .heic original.
  if (!existingObjectPath) {
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, buffer, { contentType });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      const msg = uploadError.message?.includes("not found")
        ? "Storage bucket not configured. Please contact support."
        : "Failed to upload file. Please try again.";
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  } else if (existingObjectPath !== storagePath) {
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, buffer, { contentType });
    if (uploadError) {
      console.error("Storage upload error (converted object):", uploadError);
      return NextResponse.json({ error: "Failed to upload file. Please try again." }, { status: 500 });
    }
    const { error: removeErr } = await supabase.storage.from("documents").remove([existingObjectPath]);
    if (removeErr) console.warn("[upload] could not remove pre-convert object:", removeErr.message);
  }

  // Insert document record. NOTE: `purpose` is set in a follow-up UPDATE
  // (rather than included in this insert) so the upload route still works
  // before mig 078 is applied — if the documents.purpose column doesn't exist,
  // the UPDATE errors silently and the upload falls back to primary behavior
  // downstream. Once mig 078 is applied, the UPDATE persists purpose and the
  // processing pipeline branches correctly for comparison uploads.
  const { error: dbError } = await supabase.from("documents").insert({
    id: documentId,
    user_id: ctx.user.id,
    storage_path: storagePath,
    file_name: fileName,
    file_size: originalSize,
    doc_type: docType,
    consent_event_id: ctx.consentEventId,
    status: "uploaded",
    // S74.5 D11 — write the hash so future re-uploads dedup at the check
    // above. Pre-mig 090 DBs will reject this insert; tolerated by wrapping
    // the file_hash column write in a follow-up UPDATE pattern (same as
    // mig 078 purpose handling). Simpler: insert with hash inline; if mig
    // is unapplied the entire insert fails (loud rather than silent). At
    // this point mig 090 is a hard prereq.
    file_hash: fileHash,
  });

  if (dbError) {
    // S322 — idempotent completion: a retried upload-complete whose first run
    // already inserted the row lands here on the PK conflict. Return the
    // current state instead of a 500 so the client's one retry is safe.
    if (dbError.code === "23505") {
      const { data: existing } = await supabase
        .from("documents")
        .select("id, status")
        .eq("id", documentId)
        .maybeSingle();
      if (existing) {
        return NextResponse.json({
          documentId,
          storagePath,
          status: existing.status as string,
          alreadyIngested: true,
        });
      }
    }
    console.error("Document insert error:", dbError);
    return NextResponse.json({ error: "Failed to save document record." }, { status: 500 });
  }

  // Mig 078 (additive) — set purpose only when it differs from the default
  // "primary". Wrapped to swallow errors silently so the upload still works
  // if the column doesn't exist yet (pre-mig DB falls back to primary
  // treatment downstream — i.e., comparison uploads will overwrite until
  // the migration is applied).
  if (purpose === "comparison") {
    const { error: purposeErr } = await supabase
      .from("documents")
      .update({ purpose: "comparison" })
      .eq("id", documentId);
    if (purposeErr) {
      console.warn(
        "[upload] Could not set documents.purpose=comparison — has mig 078 been applied?",
        purposeErr.message,
      );
    }
  }

  // ── Confidence-gated processing ─────────────────────────────────────────
  // Quick-classify using first 2 pages only (saves OCR budget on rejected docs)
  const CONFIDENCE_HIGH = parseFloat(process.env.CONFIDENCE_THRESHOLD_HIGH || "0.8");
  const CONFIDENCE_LOW = parseFloat(process.env.CONFIDENCE_THRESHOLD_LOW || "0.4");

  let classification = null;
  try {
    classification = await quickClassify(buffer, contentType);

    // Store classification results
    await supabase.from("documents").update({
      classified_type: classification.classifiedType,
      classification_confidence: classification.confidence,
      type_mismatch: classification.classifiedType !== docType,
    }).eq("id", documentId);

    console.log(`[upload] Quick classify: ${classification.classifiedType} (${Math.round(classification.confidence * 100)}%) | ${classification.pageCount} pages | file: ${fileName}`);

    // ── S96: Universal page-count cap ────────────────────────────────────
    // Reject documents exceeding UPLOAD_MAX_PAGES (default 100) BEFORE OCR/chunk
    // dispatch. Document-agnostic per `feedback_universal_fixes_only` — applies
    // to all doc types (SBC / EOC / EOB / bill / card) and all insurers.
    // Pre-S96 the cap was only enforced in the legacy /api/documents/process
    // route, leaving the live upload path uncapped — which let 143-370 page
    // bundles into the chunk pipeline where they hit the 5-min Vercel function
    // timeout (QStash enqueue + direct-fetch fallback both fail). Cap value
    // tunable via UPLOAD_MAX_PAGES env var; PROD default 100.
    const { getFlags } = await import("@/lib/config/feature-flags");
    const flags = await getFlags();
    if (classification.pageCount > flags.UPLOAD_MAX_PAGES) {
      // User-facing copy — warm + actionable. Avoids "SBC"/"EOC" jargon since
      // most users don't know those acronyms; suggests the practical action
      // (upload the specific section instead of the full booklet).
      const errorMsg = `This document is too large for us to read right now. It's ${classification.pageCount} pages, and we can process up to ${flags.UPLOAD_MAX_PAGES} pages at a time. Try uploading just the part of your plan or bill you'd like Candid to review.`;
      console.warn(`[upload] Rejecting: pageCount=${classification.pageCount} > limit=${flags.UPLOAD_MAX_PAGES} | file=${fileName}`);
      await supabase.from("documents").update({
        status: "error",
        processing_step: "rejected_page_limit",
        processing_error: errorMsg,
        processing_total_pages: classification.pageCount,
      }).eq("id", documentId);
      return NextResponse.json(
        {
          error: errorMsg,
          pageCount: classification.pageCount,
          limit: flags.UPLOAD_MAX_PAGES,
          documentId,
        },
        { status: 413 },
      );
    }

    // ── S91: Effective doc-type resolver ─────────────────────────────────
    // Apply the override resolver (Rule 1 + Rule 2 per /admin/upload-settings
    // config). Always logs the resolution to documents.metadata.classification_override
    // for empirical tuning (Option A — even non-overrides get logged so the
    // admin tuning page can show user_pick vs effective doc_type histograms).
    try {
      const { resolveEffectiveDocType } = await import(
        "@/lib/documents/effective-doc-type"
      );
      const { loadDocTypeOverrideConfig } = await import(
        "@/lib/config/doc-type-override-config"
      );
      const overrideConfig = await loadDocTypeOverrideConfig(supabase);
      const resolution = resolveEffectiveDocType(
        docType as "eob" | "itemized_bill" | "sbc" | "plan_document",
        classification.classifiedType,
        classification.confidence,
        classification.pageCount,
        overrideConfig,
      );

      // Always persist the resolution for analytics (Option A). When the
      // effective type differs from user pick, also UPDATE documents.doc_type
      // so downstream parser dispatch uses the resolved value.
      const overrideMeta = {
        user_pick: resolution.userPick,
        classifier_type: resolution.classifierType,
        classifier_confidence: resolution.classifierConfidence,
        page_count: resolution.pageCount,
        effective_doc_type: resolution.effectiveDocType,
        override_reason: resolution.overrideReason,
        config_classifier_confidence_override: overrideConfig.classifier_confidence_override,
        config_sbc_max_pages: overrideConfig.sbc_max_pages,
        config_family_refinement_confidence: overrideConfig.family_refinement_confidence,
        config_enabled: overrideConfig.enabled,
        // S320: pdf-lib sampling fell back to full-document classification —
        // queryable so the frequency of pdf-lib-hostile uploads is measurable.
        sampling_fallback: classification.samplingFallback ?? null,
        resolved_at: new Date().toISOString(),
      };

      if (resolution.effectiveDocType !== docType) {
        console.log(
          `[upload] doc_type override: user=${docType} → effective=${resolution.effectiveDocType} (reason=${resolution.overrideReason}, classifier=${classification.classifiedType}@${classification.confidence.toFixed(2)}, pages=${classification.pageCount})`,
        );
        await supabase
          .from("documents")
          .update({
            doc_type: resolution.effectiveDocType,
            metadata: { classification_override: overrideMeta },
          })
          .eq("id", documentId);
        docType = resolution.effectiveDocType;
      } else {
        // No override — but still log to metadata so the admin tuning page has
        // a uniform dataset across all uploads (override-rate denominator).
        await supabase
          .from("documents")
          .update({ metadata: { classification_override: overrideMeta } })
          .eq("id", documentId);
      }

      // ── S94 B5: Doc-type confirmation halt ───────────────────────────────
      // When Pattern P didn't override (classifier confidence below 0.8) but
      // the regex classifier nevertheless disagrees with the user pick above
      // a moderate threshold, halt the pipeline and ask the user to confirm.
      // Catches the SBC-uploaded-as-Bill case where regex said sbc@0.60 — too
      // low for an automatic override, high enough that silently trusting the
      // user pick is wrong. Gated by classifier_haiku_regex_fallback_v1.
      //
      // CRITICAL: only fire on cross-CLASS disagreement AND only when both
      // sides are picker-renderable (the 2-card UI can show buttons for them).
      // shouldHaltForUserConfirmation enforces both gates — intra-plan-doc-class
      // disagreements (e.g., user=plan_document + regex=sbc) are NOT
      // user-actionable because both route through the same unified plan_doc
      // parser in PROD; non-picker classifier outputs ('other',
      // 'insurance_card', 'eoc', etc.) are not user-actionable because the
      // modal can't render a useful choice.
      if (resolution.overrideReason === "user_pick_classifier_low_confidence") {
        const { loadClassifierFallbackConfig } = await import(
          "@/lib/config/classifier-fallback-config"
        );
        const { shouldHaltForUserConfirmation } = await import(
          "@/lib/classifier/fallback"
        );
        const fallbackConfig = await loadClassifierFallbackConfig(supabase);
        const halt = shouldHaltForUserConfirmation(
          resolution.userPick,
          resolution.classifierType,
        );
        if (
          halt &&
          fallbackConfig.enabled &&
          fallbackConfig.confirmation_ui_enabled &&
          resolution.classifierConfidence >= fallbackConfig.confirmation_regex_threshold &&
          resolution.classifierConfidence < overrideConfig.classifier_confidence_override
        ) {
          const confirmationMeta = {
            user_pick: resolution.userPick,
            classifier_pick: resolution.classifierType,
            classifier_confidence: resolution.classifierConfidence,
            page_count: resolution.pageCount,
            options: [resolution.userPick, resolution.classifierType],
            confirmation_regex_threshold: fallbackConfig.confirmation_regex_threshold,
            presented_at: new Date().toISOString(),
          };
          console.log(
            `[upload] awaiting_doc_type_confirmation: user=${resolution.userPick} regex=${resolution.classifierType}@${resolution.classifierConfidence.toFixed(2)} (band ${fallbackConfig.confirmation_regex_threshold}-${overrideConfig.classifier_confidence_override})`,
          );
          await supabase
            .from("documents")
            .update({
              status: "awaiting_user_confirmation",
              processing_step: "awaiting_doc_type_confirmation",
              metadata: {
                classification_override: overrideMeta,
                doc_type_confirmation: confirmationMeta,
              },
            })
            .eq("id", documentId);
          // Cost-H (S267) — carry the async tier on the confirmation response so
          // a >REDIRECT doc that trips the doc-type modal shows the splash after
          // the user confirms (FE captures the signal at page.tsx:542, which runs
          // before the confirmation branch, and it persists through confirm).
          const { isLargeDoc, willEmail } = await resolveUploadAsyncTier(
            classification.pageCount,
            contentType,
            decodedEmail,
          );
          return NextResponse.json({
            documentId,
            storagePath,
            status: "awaiting_user_confirmation",
            awaitingDocTypeConfirmation: true,
            confirmation: confirmationMeta,
            isLargeDoc,
            willEmail,
          });
        }
      }
    } catch (resolverErr) {
      // Non-fatal — if the resolver itself crashes, fall through with user's
      // pick. Logged so we can investigate.
      console.warn("[upload] doc-type resolver failed (non-fatal):", resolverErr);
    }
  } catch (classifyErr) {
    console.error("[upload] Quick classification failed:", classifyErr);
    // Fix 11: Don't leave doc in "uploaded" limbo — mark as error
    await supabase.from("documents").update({
      status: "error",
      processing_error: "Classification failed — please retry or contact support.",
    }).eq("id", documentId);
    try {
      await notifyAdminForReview(documentId, "unknown", 0, fileName, decodedEmail);
    } catch { /* non-critical */ }
    return NextResponse.json({ documentId, storagePath, status: "error", error: "Classification failed" }, { status: 500 });
  }

  const userEmail = decodedEmail;

  // ── Smart-skip moved to chunk processor (S101 refactor) ────────────────
  // Smart-skip dedup (canonical match → skip Haiku extraction) used to run
  // here inline, which blocked the upload response on a 10-20s Haiku
  // identifier-extraction call. It now runs at the top of /api/documents/
  // process-chunk's init step, AFTER OCR chunk 0 completes. The user sees
  // "Page 0 of N" as soon as the upload route returns (~3-5s); smart-skip
  // happens in the background. Smart-skip cost savings preserved 1:1 —
  // linkDocumentToCanonical still fires the moment a stable canonical match
  // is found, same logic, same Pattern 1 #16 v4 stability checks.
  //
  // See: src/app/api/documents/process-chunk/route.ts (runSmartSkipCheck).

  // ── File hash rate limit (same file 3+ times → reject) ──────────────────
  // fileHash computed above and persisted to the documents row at insert time.
  //
  // CF-36: test account also exempt from per-file-hash duplicate limit so
  // testing the same SBC repeatedly doesn't trip the rate limiter.
  if (!ctx.exemptFromCaps) {
    const { count: hashCount } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ctx.user.id)
      .eq("file_hash", fileHash);

    if (hashCount != null && hashCount >= 3) {
      await supabase.from("documents").update({
        status: "error",
        processing_error: "This file has been uploaded too many times.",
      }).eq("id", documentId);
      return NextResponse.json(
        { error: "You've already uploaded this file 3 times. Use the retry button on your existing upload if you need to reprocess." },
        { status: 429 }
      );
    }
  }

  // HIGH confidence — queue for processing via QStash (guaranteed delivery)
  // ALL documents go through the same chunked pipeline — no fire-and-forget fetch.
  if (classification.confidence >= CONFIDENCE_HIGH) {
    try {
      await supabase.from("documents").update({
        status: "queued",
        processing_total_pages: classification.pageCount,
      }).eq("id", documentId);

      const enqueued = await enqueueChunk(documentId, deriveBaseUrl(req));

      if (!enqueued) {
        await supabase.from("documents").update({
          status: "error",
          processing_error: "Failed to enqueue for processing — please retry.",
        }).eq("id", documentId);
        return NextResponse.json({ documentId, storagePath, status: "error", error: "Failed to enqueue" }, { status: 500 });
      }

      // S78 / Cost-H.2 (S198) — async ingestion gate. Large PDFs get the async
      // "go explore" splash + banner UX (isLargeDoc, pageCount > REDIRECT) and,
      // for the larger tier, the parse-complete email too (pageCount > EMAIL).
      // Sub-REDIRECT docs keep the sync PlayfulParsingScreen flow. Gated behind
      // `async_ingestion_ux_v1` (mig 085). Page-count gate is purely PDF-based —
      // HEIC / JPEG cards are 1 "page" and always sync. Both thresholds default
      // 30 (= the prior single gate) → unchanged until REDIRECT is lowered (15)
      // in lockstep with the frontend tier-aware copy (§R.2). Cost-H (S267): all
      // three processing-bound paths resolve the tier via resolveUploadAsyncTier
      // so they emit the same signal (closes the S198 medium-conf FIRING-GAP).
      // The pure classifyAsyncDocTier (called inside the helper) stays the
      // fixture's one source of truth for the two-tier semantics.
      const { isLargeDoc, willEmail } = await resolveUploadAsyncTier(
        classification.pageCount,
        contentType,
        userEmail,
      );

      return NextResponse.json({
        documentId,
        storagePath,
        autoProcessed: true,
        isLargeDoc,
        willEmail,
        // B2-UP.1 — surface effective doc-type post-resolver so the frontend
        // can reconcile state + show a "looks like this was actually a X"
        // banner when Pattern P silently overrode the user's pick at high
        // confidence (≥0.95 — too high to trigger DocTypeConfirmationModal,
        // high enough to silently correct).
        resolvedDocType: docType,
        classification: {
          classifiedType: classification.classifiedType,
          confidence: classification.confidence,
          pageCount: classification.pageCount,
        },
      });
    } catch (err) {
      console.error("[upload] Auto-process error:", err);
      // Fall through — at least the document is stored
    }
  }

  // S90 asymmetric trust rule. Classifier confidence is a noisy signal —
  // measured 0.6 vs 0.99 on back-to-back identical-shape SBC uploads.
  // Threshold tiers route the trade-off between auto-process friction
  // (good for users) and downstream risk (bad if values are wrong).
  //
  // Plan-docs (sbc/eoc/plan_document):
  //   - HIGH ≥0.8         → full process (canonical + user)
  //   - MEDIUM 0.4-0.8    → auto-process user-scoped only (dispatcher's
  //                          resolveDocumentType returns skipCanonical=true
  //                          → shared canonical_plans untouched per Pattern
  //                          1 #14). Frontend renders supplement prompt.
  //   - LOW <0.4          → pending_review
  //
  // Bills (eob/itemized_bill):
  //   - HIGH ≥0.8         → full process (audit fires; dispute enabled)
  //   - UPPER-MED 0.6-0.8 → auto-process + verification supplement prompt
  //                          gating dispute generation (CROA-risk mitigation
  //                          via user-in-the-loop, not blocking).
  //   - LOWER-MED 0.4-0.6 → pending_review (parser misread on shaky data
  //                          could produce wrong recovery amounts → wrong
  //                          dispute letter → CROA exposure).
  //   - LOW <0.4          → pending_review
  const userSelectedHealthcareType = ["eob", "itemized_bill", "sbc", "plan_document"].includes(docType);
  const effectiveType = userSelectedHealthcareType ? docType : classification.classifiedType;
  const PLAN_DOC_TYPES = new Set(["sbc", "eoc", "plan_document"]);
  const BILL_TYPES_SET = new Set(["eob", "itemized_bill"]);
  // PR4 (S142) — bumped 0.60 → 0.55 after smoke surfaced a multi-line Cigna
  // EOB (cignaEOB.pdf) clocking 0.59 classifier confidence routed to
  // pending_review when content + math identified it as a clean EOB. The
  // classifier is documented-noisy (see the S90 note above: "0.6 vs 0.99 on
  // identical-shape SBC uploads"). Lowering the floor 5pp absorbs the
  // immediate boundary case + similar near-floor uploads. Trade-off: more
  // 0.55-0.6 confidence bills auto-process; risk = false-positive on actually-
  // misclassified docs producing nonsense audit results. Mitigated by PR4's
  // bill_parser_decisions verifier infra (B-2 header reconciliation + B-3 sign
  // convention + B-1 sum-equals-header) — incoherent extractions surface in
  // /admin/review-queue Bills tab + Slack alert to C0B6EMR0AET. Proper fix
  // (flag-tunable threshold + Haiku re-classify pass at boundary) deferred to
  // Ing-F (out of pre-launch scope per S123).
  const CONFIDENCE_BILL_AUTO_FLOOR = 0.55;
  const isPlanDocPath = PLAN_DOC_TYPES.has(effectiveType);
  const isBillPath = BILL_TYPES_SET.has(effectiveType);

  const autoProcessAtMedium =
    (classification.confidence >= CONFIDENCE_LOW && isPlanDocPath) ||
    (classification.confidence >= CONFIDENCE_BILL_AUTO_FLOOR && isBillPath);

  if (autoProcessAtMedium) {
    try {
      await supabase.from("documents").update({
        status: "queued",
        processing_total_pages: classification.pageCount,
      }).eq("id", documentId);

      const enqueued = await enqueueChunk(documentId, deriveBaseUrl(req));

      if (!enqueued) {
        await supabase.from("documents").update({
          status: "error",
          processing_error: "Failed to enqueue for processing — please retry.",
        }).eq("id", documentId);
        return NextResponse.json({ documentId, storagePath, status: "error", error: "Failed to enqueue" }, { status: 500 });
      }

      // Cost-H (S267) — close the S198 FIRING-GAP: the medium-confidence path
      // must emit the SAME async-tier signal as the high-confidence path, else a
      // large doc landing medium-confidence blind-waits (no splash) while the
      // email/banner still fire on their own page gates.
      const { isLargeDoc, willEmail } = await resolveUploadAsyncTier(
        classification.pageCount,
        contentType,
        userEmail,
      );

      return NextResponse.json({
        documentId,
        storagePath,
        autoProcessed: true,
        mediumConfidence: true,
        isLargeDoc,
        willEmail,
        // B2-UP.1 — surface effective doc-type (see HIGH-confidence response above).
        resolvedDocType: docType,
        classification: {
          classifiedType: classification.classifiedType,
          confidence: classification.confidence,
          pageCount: classification.pageCount,
        },
      });
    } catch (err) {
      console.error("[upload] Auto-process (medium) error:", err);
      // Fall through to pending_review
    }
  }

  // Escalate-don't-dead-end: the user EXPLICITLY declared a healthcare type
  // (Bill / Plan Document) but the quick classifier is under its auto-process
  // floor. The quick classify is a cheap 4-page-sample pre-filter — documented-
  // noisy, and artificially low on docs whose identifying pages don't decode
  // (e.g. an EOB whose claim table is an undecodable text layer). Rather than
  // park a user-declared healthcare doc in admin review, hand it to the
  // authoritative full-text Haiku classify + the pipeline's own gates:
  // `resolveDocumentType` re-classifies on the full OCR (which now recovers
  // undecodable pages via ocr_undecodable_page_fallback_v1, so it sees the claim
  // page the quick sample missed) and halts ITSELF if it's genuinely unsure;
  // dispute generation keeps its verification-supplement gate. Non-user-typed
  // low-signal docs still fall through to admin review / auto-reject below.
  if (userSelectedHealthcareType) {
    try {
      await supabase.from("documents").update({
        status: "queued",
        processing_total_pages: classification.pageCount,
      }).eq("id", documentId);

      const enqueued = await enqueueChunk(documentId, deriveBaseUrl(req));

      if (enqueued) {
        const { isLargeDoc, willEmail } = await resolveUploadAsyncTier(
          classification.pageCount,
          contentType,
          userEmail,
        );
        console.log(
          `[upload] escalate-to-full-processing: user=${docType} classifier=${classification.classifiedType}@${classification.confidence.toFixed(2)} (below auto floor) → queued for authoritative full-text classify`,
        );
        return NextResponse.json({
          documentId,
          storagePath,
          autoProcessed: true,
          escalatedLowConfidence: true,
          isLargeDoc,
          willEmail,
          resolvedDocType: docType,
          classification: {
            classifiedType: classification.classifiedType,
            confidence: classification.confidence,
            pageCount: classification.pageCount,
          },
        });
      }
      console.warn("[upload] escalate enqueue failed — falling through to pending_review");
    } catch (err) {
      console.error("[upload] escalate-to-full-processing error — falling through to pending_review:", err);
    }
    // Enqueue failed → fall through to the pending_review branch below.
  }

  // MEDIUM confidence bill/EOB OR any other healthcare signal — queue for
  // admin review. Auto-reject only when classifier finds zero signals AND the
  // user didn't select a specific type.
  if (classification.confidence >= CONFIDENCE_LOW || classification.classifiedType !== "other" || userSelectedHealthcareType) {
    await supabase.from("documents").update({ status: "pending_review" }).eq("id", documentId);

    // Notify admin (email + Slack) and user (email) — non-blocking
    Promise.allSettled([
      notifyAdminForReview(documentId, classification.classifiedType, classification.confidence, fileName, userEmail),
      notifyUserPendingReview(userEmail, fileName),
    ]).catch(() => {});

    // Also queue for pipeline discovery if it looks like an SBC
    if (classification.classifiedType === "sbc" || classification.classifiedType === "plan_document") {
      const { data: profile } = await supabase
        .from("profiles")
        .select("insurer")
        .eq("user_id", ctx.user.id)
        .single();

      const insurerRaw = profile?.insurer || "Unknown";
      const insurerMatch = await matchInsurerCatalog(supabase, insurerRaw);

      const { error: queueErr } = await supabase.from("insurer_discovery_queue").insert({
        insurer_name_raw: insurerRaw,
        requested_by: ctx.user.id,
        source: "user_submitted",
        source_document_id: documentId,
        status: "pending",
        matched_insurer_id: insurerMatch?.id || null,
      });
      if (queueErr) console.warn("[upload] Discovery queue insert failed:", queueErr.message);
    }

    return NextResponse.json({
      documentId,
      storagePath,
      status: "pending_review",
      classification: {
        classifiedType: classification.classifiedType,
        confidence: classification.confidence,
        pageCount: classification.pageCount,
      },
    });
  }

  // No healthcare signals at all — auto-decline
  await supabase.from("documents").update({ status: "rejected" }).eq("id", documentId);
  console.log(`[upload] Auto-rejected: ${fileName} (${Math.round(classification.confidence * 100)}% as ${classification.classifiedType})`);

  return NextResponse.json({
    documentId,
    storagePath,
    status: "rejected",
    classification: {
      classifiedType: classification.classifiedType,
      confidence: classification.confidence,
    },
    message: "This doesn't appear to be a healthcare document. Please upload an insurance card, Summary of Benefits (SBC), Explanation of Benefits (EOB), or medical bill.",
  });
}
