import { notFound } from "next/navigation";
import StreamView from "@/components/stream/StreamView";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Profile, Product, Stream } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function StreamPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: streamRow, error } = await supabase
    .from("streams")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !streamRow) {
    notFound();
  }
  const stream = streamRow as Stream;

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", stream.seller_id)
    .single();
  const seller = (profileRow as Profile | null) ?? null;

  // Current pinned product (if any) — passed as initial state; realtime keeps
  // it fresh on the client.
  let pinnedProduct: Product | null = null;
  if (stream.pinned_product_id) {
    const { data: p } = await supabase
      .from("products")
      .select("*")
      .eq("id", stream.pinned_product_id)
      .single();
    pinnedProduct = (p as Product | null) ?? null;
  }

  // Viewer identity — must be logged in to chat/buy and to get a viewer token.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isSeller = user?.id === stream.seller_id;

  // Full-screen Douyin-style shell. No Navbar here — the TopBar close button is
  // the only way back to the stream list. See StreamView for the layout spec.
  return (
    <StreamView
      stream={stream}
      seller={seller}
      initialPinnedProduct={pinnedProduct}
      role={isSeller ? "seller" : "viewer"}
      viewerId={user?.id ?? null}
      viewerName={user?.email ?? undefined}
    />
  );
}
