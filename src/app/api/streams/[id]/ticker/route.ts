import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

interface RecentPurchase {
  buyer_name: string;
  product_name: string;
  created_at: string;
}

/**
 * Returns the rolling "added to cart" count for a stream + the single most
 * recent purchase (truncated buyer display name + product name) for the §3.2
 * per-buyer purchase pill.
 *
 *   { count: number, recent: { buyer_name, product_name } | null }
 *
 * Read via the service role because RLS only lets a buyer read their own orders
 * or a seller read orders on their products — this aggregate is meant for every
 * viewer, so we bypass RLS. We return ONLY:
 *   - the integer count (no ids)
 *   - the buyer's DISPLAY NAME (truncated to 16 chars) + product name — never
 *     buyer ids, emails, or order ids. This is the same PII surface a seller's
 *     public order activity would imply; if you want it fully anonymous, see the
 *     ANON_FALLBACK constant below.
 *
 * Polled (~every 12s) by PurchaseTicker as a seed; live pills arrive via the
 * Supabase Realtime `orders` INSERT subscription the client also opens.
 */
const MAX_NAME_LEN = 16;
const ANON_FALLBACK = "Someone"; // shown when the buyer has no display name

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: streamId } = await params;
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const service = createSupabaseServiceClient();

  // Count + most-recent purchase (with the buyer's display name via the
  // buyer_id → profiles join). Run both in parallel.
  const [countRes, recentRes] = await Promise.all([
    service
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("stream_id", streamId)
      .in("status", ["pending", "paid"])
      .gt("created_at", since),
    service
      .from("orders")
      .select(
        "created_at, product:products(name), buyer:buyer_id(display_name)",
      )
      .eq("stream_id", streamId)
      .in("status", ["pending", "paid"])
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (countRes.error) {
    return NextResponse.json({ error: countRes.error.message }, { status: 500 });
  }

  let recent: RecentPurchase | null = null;
  if (recentRes.data) {
    const row = recentRes.data as unknown as {
      created_at: string;
      product: { name: string } | null;
      buyer: { display_name: string | null } | null;
    };
    const rawName = row.buyer?.display_name?.trim() || ANON_FALLBACK;
    recent = {
      buyer_name:
        rawName.length > MAX_NAME_LEN ? rawName.slice(0, MAX_NAME_LEN) + "…" : rawName,
      product_name: row.product?.name ?? "an item",
      created_at: row.created_at,
    };
  }

  return NextResponse.json({ count: countRes.count ?? 0, recent });
}

