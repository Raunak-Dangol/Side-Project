import { redirect } from "next/navigation";
import Navbar from "@/components/Navbar";
import SellerApplyForm from "@/components/SellerApplyForm";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SellerApplyPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?redirect=/seller/apply");

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  const profile = profileRow as
    | (typeof profileRow & {
        seller_status: "none" | "pending" | "approved" | "rejected";
      })
    | null;

  // Already approved → no need to apply, go straight to the dashboard.
  if (profile?.seller_status === "approved") {
    redirect("/seller/dashboard");
  }

  // ★ profiles.seller_status is THE single source of truth for page state.
  // We branch on it first and fetch application rows only for display detail
  // (timestamp, reviewer note) — never to decide which state to show. This
  // prevents a stale 'pending' application row from masking a rejected (or
  // other) profile state.
  let detail: { businessName: string | null; submittedAt: string | null } = {
    businessName: null,
    submittedAt: null,
  };
  let rejectedNote: string | null = null;

  if (profile?.seller_status === "pending") {
    // Show the most recent pending application's info (there's at most one).
    const { data: pendingRow } = await supabase
      .from("seller_applications")
      .select("business_name, submitted_at")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    const row = pendingRow as
      | { business_name: string | null; submitted_at: string | null }
      | null;
    detail = {
      businessName: row?.business_name ?? null,
      submittedAt: row?.submitted_at ?? null,
    };
  } else if (profile?.seller_status === "rejected") {
    // Most recent rejected application — purely to surface the reviewer's note.
    // Does not gate reapplication.
    const { data: rejectedRow } = await supabase
      .from("seller_applications")
      .select("reviewer_note, reviewed_at")
      .eq("user_id", user.id)
      .eq("status", "rejected")
      .order("reviewed_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    rejectedNote = (rejectedRow as { reviewer_note: string | null } | null)
      ?.reviewer_note ?? null;
  }

  return (
    <>
      <Navbar />
      <div className="mx-auto max-w-lg px-4 py-8">
        <h1 className="text-2xl font-semibold mb-1">Become a seller</h1>
        <p className="text-sm text-slate-500 mb-6">
          Submit a short application. Once approved, you can create products and
          go live — your normal account stays exactly the same.
        </p>

        {profile?.seller_status === "pending" ? (
          <div className="card p-6 bg-amber-50 border-amber-200">
            <h2 className="font-semibold text-amber-900 mb-1">
              Your application is under review
            </h2>
            <p className="text-sm text-amber-800">
              We received your application
              {detail.businessName ? ` for “${detail.businessName}”` : ""}
              {detail.submittedAt
                ? ` on ${new Date(detail.submittedAt).toLocaleString()}`
                : ""}
              . You&apos;ll gain access to the seller dashboard once it&apos;s
              approved.
            </p>
          </div>
        ) : profile?.seller_status === "rejected" ? (
          <div className="space-y-4">
            <div className="card p-6 bg-rose-50 border-rose-200">
              <h2 className="font-semibold text-rose-900 mb-1">
                Your last application wasn&apos;t approved
              </h2>
              <p className="text-sm text-rose-800">
                {rejectedNote
                  ? `Reviewer note: ${rejectedNote}`
                  : "No additional detail was provided."}
              </p>
              <p className="text-sm text-rose-800 mt-2">
                You can submit a new application below.
              </p>
            </div>
            <SellerApplyForm userId={user.id} />
          </div>
        ) : (
          // 'none' or profile missing → fresh application form.
          <SellerApplyForm userId={user.id} />
        )}
      </div>
    </>
  );
}
