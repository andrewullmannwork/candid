import { isFeatureEnabled } from "@/lib/config/product-flags";
import SupportClient from "./SupportClient";

export default async function SupportPage() {
  // Server-side flag check. support_faq_v1 is global-targeted; no user email needed.
  // Flag is OFF by default per D-§1.B.3-B; flip ON when curated FAQ content lands.
  const faqEnabled = await isFeatureEnabled("support_faq_v1");
  return <SupportClient faqEnabled={faqEnabled} />;
}
