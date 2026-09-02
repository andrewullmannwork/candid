// S330 — send ONE sample intake-decline email to an address Andrew named, so he can see it delivered. DEV-guarded.
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { sendDfyDeclineEmail } from "../src/lib/email/dfy-emails";
import { MEMBER_DECLINE_COPY } from "../src/lib/dfy/intake-gates";
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
const to = process.argv[2];
if (!to) { console.error("usage: s330-probe-decline-email.ts <to>"); process.exit(1); }
(async () => {
  const ok = await sendDfyDeclineEmail({ to, firstName: "Andrew", claimId: "2a8f87c6-45e1-4c89-a96e-73a1803fe651", reason: MEMBER_DECLINE_COPY["0"] });
  console.log("sample decline email →", to, ok ? "sent" : "NOT sent");
})();
