import { notFound } from "next/navigation";
import Navbar from "@/components/Navbar";
import StreamRoom from "@/components/StreamRoom";
import ChatPanel from "@/components/ChatPanel";
import PinnedProduct from "@/components/PinnedProduct";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Profile, Product, Stream } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function StreamPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = createSupabaseServerClient();

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

  return (
    <>
      <Navbar />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
          {/* Left: video + pinned product */}
          <div className="space-y-4">
            <div className="card p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h1 className="font-semibold text-lg">{stream.title}</h1>
                  <p className="text-xs text-slate-500">
                    by {seller?.display_name ?? "Unknown seller"}
                  </p>
                </div>
                {stream.status === "live" ? (
                  <span className="badge bg-rose-100 text-rose-700">● LIVE</span>
                ) : (
                  <span className="badge bg-slate-100 text-slate-500">
                    {stream.status}
                  </span>
                )}
              </div>
              <div className="aspect-video bg-slate-900 rounded overflow-hidden">
                <StreamRoom
                  stream={stream}
                  role={isSeller ? "seller" : "viewer"}
                  viewerId={user?.id ?? null}
                  viewerName={user?.email ?? undefined}
                />
              </div>
            </div>
            <PinnedProduct stream={stream} initialProduct={pinnedProduct} />
          </div>

          {/* Right: chat */}
          <div className="h-[70vh] lg:h-[80vh]">
            <ChatPanel streamId={stream.id} />
          </div>
        </div>
      </div>
    </>
  );
}
