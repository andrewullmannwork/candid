import { redirect } from "next/navigation";

// Bare /admin has no page of its own — send it to the To-Do Center dashboard so
// typing "/admin" (or landing there from a stale link) never 404s.
export default function AdminIndexPage() {
  redirect("/admin/dashboard");
}
