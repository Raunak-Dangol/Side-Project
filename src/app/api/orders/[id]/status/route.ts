import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import type { Order, OrderStatus } from "@/lib/types";

/**
 * GET /api/orders/[id]/status — the polling endpoint for §9.B checkout status
 * reconciliation. Auth-gated to the order's buyer so nobody can probe other
 * users' order states.
 *
 * Returns just the order's status + needs_refund flag — nothing else. The
 * return page polls this every few seconds while the order is `pending` so a
 * gateway-side `Completed` payment (picked up by the webhook) flips the buyer's
 * screen to paid without a manual reload.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing order id" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) {
    return NextResponse.json({ error: "Sign in to view order" }, { status: 401 });
  }

  // RLS already scopes reads to the buyer, but we filter explicitly too so a
  // stale session token can't reach another user's row.
  const { data: orderRow } = await supabase
    .from("orders")
    .select("id, buyer_id, status, needs_refund")
    .eq("id", id)
    .eq("buyer_id", user.id)
    .maybeSingle();
  const order = orderRow as Pick<Order, "id" | "buyer_id" | "status" | "needs_refund"> | null;

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  const body: { status: OrderStatus; needsRefund: boolean } = {
    status: order.status,
    needsRefund: order.needs_refund,
  };
  return NextResponse.json(body);
}
