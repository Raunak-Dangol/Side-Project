import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { khaltiLookup } from "@/lib/payments/khalti";
import { callFulfillOrder } from "@/lib/payments/fulfill";
import { getAuthenticatedUser } from "@/lib/auth";
import type { Order } from "@/lib/types";

const Body = z.object({
  orderId: z.string().uuid(),
  pidx: z.string().min(1),
});

/**
 * POST /api/checkout/reconcile
 *
 * Protected reconciliation for stuck pending Khalti orders. Reruns the
 * authoritative Khalti lookup and, if the payment is Completed with matching
 * amount and pidx, calls fulfill_order idempotently.
 *
 * Auth: the buyer who owns the order (or an admin). We check ownership via the
 * session client BEFORE any service-role query runs.
 */
export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = createSupabaseServiceClient();

  // Find the order by id.
  const { data: orderRow } = await service
    .from("orders")
    .select("*")
    .eq("id", parsed.orderId)
    .eq("payment_gateway", "khalti")
    .maybeSingle();
  const order = (orderRow as Order | null) ?? null;
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  // Ownership: the buyer who placed the order may reconcile their own payment.
  if (order.buyer_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Require pidx match.
  if (order.khalti_pidx && order.khalti_pidx !== parsed.pidx) {
    return NextResponse.json({ error: "pidx mismatch" }, { status: 400 });
  }

  // Already reconciled?
  if (order.status === "paid") {
    return NextResponse.json({ outcome: "already_handled", orderId: order.id });
  }

  // Authoritative Khalti lookup.
  let lookup;
  try {
    lookup = await khaltiLookup(parsed.pidx);
  } catch (e) {
    console.error(`[reconcile] lookup failed order=${order.id}`, e);
    return NextResponse.json({ error: "Khalti lookup failed" }, { status: 502 });
  }

  console.info("[reconcile] lookup result", {
    orderId: order.id,
    status: lookup.status,
    totalAmount: lookup.total_amount,
    expectedAmount: order.amount_cents,
    purchaseOrderId: lookup.purchase_order_id,
    hasTransactionId: Boolean(lookup.transaction_id),
  });

  // Require Completed.
  if (lookup.status !== "Completed") {
    return NextResponse.json({
      outcome: "not_completed",
      status: lookup.status,
      orderId: order.id,
    });
  }

  // Require amount match.
  if (lookup.total_amount !== order.amount_cents) {
    console.error(
      `[reconcile] amount mismatch order=${order.id} expected=${order.amount_cents} got=${lookup.total_amount}`,
    );
    return NextResponse.json({ error: "Amount mismatch" }, { status: 400 });
  }

  // Require purchase_order_id matches order.id (new mapping) or the legacy
  // gateway_transaction_id (old mapping).
  if (
    lookup.purchase_order_id &&
    lookup.purchase_order_id !== order.id &&
    lookup.purchase_order_id !== order.gateway_transaction_id
  ) {
    console.error(
      `[reconcile] purchase_order_id mismatch order=${order.id} lookup=${lookup.purchase_order_id}`,
    );
    return NextResponse.json({ error: "purchase_order_id mismatch" }, { status: 400 });
  }

  // Require transaction_id exists.
  if (!lookup.transaction_id) {
    return NextResponse.json({ error: "No transaction_id from lookup" }, { status: 400 });
  }

  // Atomic, idempotent fulfillment.
  const { outcome, error } = await callFulfillOrder(service, {
    orderId: order.id,
    transactionId: lookup.transaction_id,
    khaltiPidx: parsed.pidx,
  });

  if (error) {
    console.error(`[reconcile] fulfill_order error order=${order.id}`, error);
  }

  return NextResponse.json({ outcome, orderId: order.id });
}
