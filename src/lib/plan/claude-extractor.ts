/**
 * Claude Haiku post-processing for plan document parsing.
 * Takes regex-extracted services + raw OCR text, returns enriched services
 * with accurate names, full descriptions, visit limits, and coverage conditions.
 *
 * Cost: ~$0.01/document (Haiku is $0.25/1M input tokens, typical doc ~3K tokens)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SBCParsedService } from "./sbc-parser";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

interface EnrichedService {
  serviceSlug: string;
  serviceName: string;
  fullDescription: string;
  visitLimit: string | null;
  priorAuthRequired: boolean | null;
  referralRequired: boolean | null;
  coverageConditions: string | null;
  inCostDescription: string;
  outCostDescription: string;
  confidence: number;
}

/**
 * Extract surrounding context (up to 600 chars) for a service from the OCR text.
 */
function getServiceContext(ocrText: string, serviceSlug: string, serviceName: string): string {
  const normalized = ocrText.toLowerCase();
  const searchTerms = [
    serviceName.toLowerCase(),
    serviceSlug.replace(/_/g, " "),
    // Try shorter versions
    serviceName.toLowerCase().split(/\s+/).slice(0, 2).join(" "),
  ];

  for (const term of searchTerms) {
    const idx = normalized.indexOf(term);
    if (idx >= 0) {
      const start = Math.max(0, idx - 100);
      const end = Math.min(ocrText.length, idx + 500);
      return ocrText.slice(start, end);
    }
  }

  return "";
}

/**
 * Enrich regex-extracted services using Claude Haiku.
 * Sends all services in a single batch to minimize API calls.
 */
export async function enrichServicesWithClaude(
  services: SBCParsedService[],
  ocrText: string,
  planName: string | null
): Promise<SBCParsedService[]> {
  if (!process.env.ANTHROPIC_API_KEY || services.length === 0) {
    return services;
  }

  // Build context snippets for each service
  const serviceContexts = services.map((s) => {
    const slugName = s.serviceSlug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const context = getServiceContext(ocrText, slugName, slugName);
    return {
      slug: s.serviceSlug,
      currentDescription: s.inCostDescription,
      currentOutDescription: s.outCostDescription,
      context: context || "(no context found in document)",
      currentLimit: s.annualLimit,
      currentPriorAuth: s.priorAuthRequired,
    };
  });

  const prompt = `You are a health insurance document parser. Given extracted services from a plan document, improve the accuracy of each service's description using the surrounding document context.

Plan: ${planName || "Unknown"}

For each service below, I'll provide:
- The service slug (identifier)
- The current extracted cost description (may be incomplete or out of context)
- The surrounding text from the plan document

Return a JSON array with one object per service:
{
  "serviceSlug": "the_service_slug",
  "name": "Clean, human-readable service name",
  "inCostDescription": "Full in-network cost description with copay, coinsurance, deductible info",
  "outCostDescription": "Full out-of-network cost description (or empty string if not found)",
  "visitLimit": "Annual/per-occurrence limit if mentioned (e.g., '60 visits per year'), or null",
  "priorAuthRequired": true/false/null,
  "referralRequired": true/false/null,
  "coverageConditions": "Any special conditions (e.g., 'requires referral from PCP', 'limited to in-network facilities'), or null",
  "confidence": 0.0-1.0 confidence in the extraction accuracy
}

Rules:
- Keep descriptions concise but complete (include copay AND coinsurance AND deductible info when present)
- If the context mentions a visit limit, ALWAYS include it
- If prior auth or referral is mentioned, set the boolean
- If you can't improve on the current description, return it unchanged
- Confidence should be 0.9+ if the context clearly confirms the service, 0.5-0.8 if partial, <0.5 if uncertain

Services to enrich:
${serviceContexts.map((s, i) => `
--- Service ${i + 1}: ${s.slug} ---
Current description: ${s.currentDescription || "(none)"}
Current out-of-network: ${s.currentOutDescription || "(none)"}
Current limit: ${s.currentLimit || "(none)"}
Current prior auth: ${s.currentPriorAuth}
Document context:
${s.context}
`).join("\n")}

Return ONLY the JSON array, no markdown fencing, no explanation.`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-20250414",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    // Parse JSON — handle potential markdown fencing
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const enriched: EnrichedService[] = JSON.parse(jsonStr);

    // Merge enriched data back into original services
    const enrichedMap = new Map(enriched.map((e) => [e.serviceSlug, e]));

    return services.map((s) => {
      const e = enrichedMap.get(s.serviceSlug);
      if (!e) return s;

      return {
        ...s,
        inCostDescription: e.inCostDescription || s.inCostDescription,
        outCostDescription: e.outCostDescription || s.outCostDescription,
        annualLimit: e.visitLimit || s.annualLimit,
        priorAuthRequired: e.priorAuthRequired ?? s.priorAuthRequired,
        coverageConditions: e.coverageConditions || s.coverageConditions,
        confidence: Math.max(s.confidence, e.confidence),
      };
    });
  } catch (err) {
    console.error("[claude-extractor] Failed to enrich services:", err);
    // Fall back to original regex-extracted services
    return services;
  }
}
