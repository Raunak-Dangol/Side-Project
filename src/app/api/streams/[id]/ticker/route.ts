import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Returns the rolling "added to cart" count for a stream: the number of orders
 * where status is 'pending' or 'paid' and created within the last 10 minutes.
 *
 * Read via the service role because RLS only lets a buyer read their own orders
 * or a seller read orders on their products — this aggregate is meant for every
 * viewer, so we bypass RLS for the count. We return ONLY the integer count, not
 * any order details, so no private data leaks.
 *
 * Polled (~every 12s) by PurchaseTicker rather than made realtime — the ticker
 * doesn't need sub-second accuracy, and polling avoids another realtime channel.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: streamId } = await params;

  const service = createSupabaseServiceClient();
  const { count, error } = await service
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("stream_id", streamId)
    .in("status", ["pending", "paid"])
    .gt("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ count: count ?? 0 });
}
