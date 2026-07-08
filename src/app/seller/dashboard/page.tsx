import { redirect } from "next/navigation";
import Navbar from "@/components/Navbar";
import SellerDashboard from "@/components/SellerDashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Product, Profile, Stream } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SellerDashboardPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?redirect=/seller/dashboard");

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  const profile = profileRow as Profile | null;

  // Buyers may view the dashboard but are prompted to opt in to selling.
  // (RLS still gates product/stream writes to the owning seller.)

  const { data: products } = await supabase
    .from("products")
    .select("*")
    .eq("seller_id", user.id)
    .order("created_at", { ascending: false });

  const { data: streams } = await supabase
    .from("streams")
    .select("*")
    .eq("seller_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <>
      <Navbar />
      <SellerDashboard
        profile={profile}
        products={(products as Product[] | null) ?? []}
        streams={(streams as Stream[] | null) ?? []}
      />
    </>
  );
}
