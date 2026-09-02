import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
const sb = createClient(url, key);
sb.storage.listBuckets().then(({ data, error }) => console.log("DEV buckets:", error ? error.message : (data ?? []).map((b) => `${b.name}(${b.public ? "public" : "private"})`).join(", ") || "NONE"));
