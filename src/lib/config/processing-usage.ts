/**
 * Tracks Document AI processing usage against daily/monthly caps.
 * Uses the processing_usage table to persist counts.
 */

import { createServerClient } from "@/lib/supabase/server";
import { getFlags } from "./feature-flags";

/** Get today's date string in Pacific time (YYYY-MM-DD) */
function getLocalDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** Get current month string in Pacific time (YYYY-MM) */
function getLocalMonthStr(): string {
  return getLocalDateStr().slice(0, 7);
}

interface UsageCheck {
  allowed: boolean;
  reason?: string;
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
}

/** Check if OCR processing is allowed under current caps */
export async function checkProcessingBudget(pages: number = 1): Promise<UsageCheck> {
  const flags = await getFlags();
  if (!flags.OCR_ENABLED) {
    return {
      allowed: false,
      reason: "Document processing is currently disabled.",
      dailyUsed: 0,
      dailyLimit: flags.OCR_DAILY_PAGE_LIMIT,
      monthlyUsed: 0,
      monthlyLimit: flags.OCR_MONTHLY_PAGE_LIMIT,
    };
  }

  const supabase = createServerClient();
  const todayStr = getLocalDateStr();
  const monthStr = getLocalMonthStr();

  // Get today's usage
  const { data: todayData } = await supabase
    .from("processing_usage")
    .select("pages_processed")
    .eq("date", todayStr)
    .single();

  const dailyUsed = todayData?.pages_processed || 0;

  // Get this month's total usage
  const { data: monthData } = await supabase
    .from("processing_usage")
    .select("pages_processed")
    .gte("date", `${monthStr}-01`)
    .lte("date", `${monthStr}-31`);

  const monthlyUsed = (monthData || []).reduce(
    (sum, row) => sum + (row.pages_processed || 0),
    0
  );

  const dailyLimit = flags.OCR_DAILY_PAGE_LIMIT;
  const monthlyLimit = flags.OCR_MONTHLY_PAGE_LIMIT;

  if (monthlyUsed + pages > monthlyLimit) {
    return {
      allowed: false,
      reason: `Monthly OCR limit reached (${monthlyUsed}/${monthlyLimit} pages). Document queued for processing.`,
      dailyUsed,
      dailyLimit,
      monthlyUsed,
      monthlyLimit,
    };
  }

  if (dailyUsed + pages > dailyLimit) {
    return {
      allowed: false,
      reason: `Daily OCR limit reached (${dailyUsed}/${dailyLimit} pages). Document queued for processing.`,
      dailyUsed,
      dailyLimit,
      monthlyUsed,
      monthlyLimit,
    };
  }

  return {
    allowed: true,
    dailyUsed,
    dailyLimit,
    monthlyUsed,
    monthlyLimit,
  };
}

/** Record pages processed for usage tracking */
export async function recordProcessingUsage(pages: number): Promise<void> {
  const supabase = createServerClient();
  const todayStr = getLocalDateStr();

  // Upsert today's usage
  const { data: existing } = await supabase
    .from("processing_usage")
    .select("id, pages_processed")
    .eq("date", todayStr)
    .single();

  if (existing) {
    await supabase
      .from("processing_usage")
      .update({ pages_processed: existing.pages_processed + pages })
      .eq("id", existing.id);
  } else {
    await supabase.from("processing_usage").insert({
      date: todayStr,
      pages_processed: pages,
    });
  }
}

/** Get current usage stats (for admin dashboard) */
export async function getUsageStats(): Promise<{
  today: number;
  month: number;
  dailyLimit: number;
  monthlyLimit: number;
  ocrEnabled: boolean;
  autoProcess: boolean;
}> {
  const flags = await getFlags();
  const supabase = createServerClient();
  const todayStr = getLocalDateStr();
  const monthStr = getLocalMonthStr();

  const { data: todayData } = await supabase
    .from("processing_usage")
    .select("pages_processed")
    .eq("date", todayStr)
    .single();

  const { data: monthData } = await supabase
    .from("processing_usage")
    .select("pages_processed")
    .gte("date", `${monthStr}-01`)
    .lte("date", `${monthStr}-31`);

  return {
    today: todayData?.pages_processed || 0,
    month: (monthData || []).reduce((s, r) => s + (r.pages_processed || 0), 0),
    dailyLimit: flags.OCR_DAILY_PAGE_LIMIT,
    monthlyLimit: flags.OCR_MONTHLY_PAGE_LIMIT,
    ocrEnabled: flags.OCR_ENABLED,
    autoProcess: flags.AUTO_PROCESS_ON_UPLOAD,
  };
}
