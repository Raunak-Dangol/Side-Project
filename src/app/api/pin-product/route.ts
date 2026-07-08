import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Stream } from "@/lib/types";

const Body = z.object({
  streamId: z.string().uuid(),
  /** null/undefined clears the pin; a uuid pins that product */
  productId: z.string().uuid().nullable(),
});

/**
 * Pins (or unpins) a product on a stream. The caller must own the stream, and
 * (if pinning) the product must belong to the same seller. The actual write
 * goes through the user's session, which RLS gates to streams they own — so
 * even if the ownership check were skipped, RLS would still deny the update.
 *
 * The update propagates to all viewers via Supabase Realtime (streams table is
 * in the supabase_realtime publication).
 */
export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch the stream to confirm ownership.
  const { data: streamRow, error: sErr } = await supabase
    .from("streams")
    .select("*")
    .eq("id", parsed.streamId)
    .single();
  if (sErr || !streamRow) {
    return NextResponse.json({ error: "Stream not found" }, { status: 404 });
  }
  const stream = streamRow as Stream;
  if (stream.seller_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // If pinning a product, confirm it belongs to this seller.
  if (parsed.productId) {
    const { data: productRow } = await supabase
      .from("products")
      .select("seller_id")
      .eq("id", parsed.productId)
      .single();
    if (!productRow || productRow.seller_id !== user.id) {
      return NextResponse.json(
        { error: "Product not found or not yours" },
        { status: 403 },
      );
    }
  }

  const { data, error } = await supabase
    .from("streams")
    .update({ pinned_product_id: parsed.productId })
    .eq("id", parsed.streamId)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(data);
}
