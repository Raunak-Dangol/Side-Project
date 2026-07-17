import { notFound } from "next/navigation";
import StreamView from "@/components/stream/StreamView";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Profile, Product, Stream } from "@/lib/types";

// The stream itself is highly interactive (realtime), so keep it dynamic — but
// note the page no longer serializes its queries (see Promise.all below).
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

  // Seller, pinned product, and the viewer's auth can all be fetched IN
  // PARALLEL once we have the stream row. Previously these were 3 sequential
  // round-trips (~300ms). The pinned-product query is skipped when nothing is
  // pinned (null placeholder keeps array order stable).
  const [sellerRes, pinnedRes, userRes] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", stream.seller_id).single(),
    stream.pinned_product_id
      ? supabase
          .from("products")
          .select("*")
          .eq("id", stream.pinned_product_id)
          .single()
      : Promise.resolve({ data: null }),
    supabase.auth.getUser(),
  ]);
  const seller = (sellerRes.data as Profile | null) ?? null;
  const pinnedProduct = (pinnedRes.data as Product | null) ?? null;
  const user = userRes.data.user ?? null;
  const isSeller = user?.id === stream.seller_id;

  // Resolve the viewer's display_name server-side. Never pass the raw email as
  // the viewer name — it would be broadcast to every other viewer via presence
  // and LiveKit (PII leak). Fall back to the email local-part only if the
  // profile row somehow has no display_name.
  let viewerName: string | undefined;
  if (user) {
    const { data: viewerProfile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .single();
    viewerName =
      viewerProfile?.display_name ?? user.email?.split("@")[0] ?? undefined;
  }

  // Full-screen Doujin-style shell. No Navbar here — the TopBar close button is
  // the only way back to the stream list. See StreamView for the layout spec.
  return (
    <StreamView
      stream={stream}
      seller={seller}
      initialPinnedProduct={pinnedProduct}
      role={isSeller ? "seller" : "viewer"}
      viewerId={user?.id ?? null}
      viewerName={viewerName}
    />
  );
}
