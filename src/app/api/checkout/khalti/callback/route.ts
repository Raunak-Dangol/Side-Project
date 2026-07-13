import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { khaltiLookup } from "@/lib/payments/khalti";
import { serverEnv } from "@/lib/env";
import type { Order } from "@/lib/types";

const Query = z.object({
  pidx: z.string().min(1),
  status: z.string().optional(),
  transaction_id: z.string().optional(),
  purchase_order_id: z.string().min(1),
});

const APP_URL = () => serverEnv.appUrl;

/**
 * Khalti redirect callback. The buyer lands here with query params after
 * paying (or cancelling). We NEVER trust these params as confirmation — we
 * immediately call the Khalti LOOKUP API with `pidx` to get the authoritative
 * status, then reconcile.
 *
 * Reconciliation rules:
 *   - Completed → try atomic stock decrement; on success mark `paid`,
 *     on oversell race mark `failed` (manual refund needed).
 *   - Pending   → leave order `pending` (hold; do not mark paid/failed).
 *   - Expired / User canceled / Refunded → mark `failed`.
 *   - Amount mismatch → mark `failed` and log (tamper protection).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  let parsed: z.infer<typeof Query>;
  try {
    parsed = Query.parse(Object.fromEntries(url.searchParams.entries()));
  } catch {
    return NextResponse.redirect(`${APP_URL()}/checkout/return?status=invalid`);
  }

  const service = createSupabaseServiceClient();

  // Find the pending order by its transaction_uuid (= purchase_order_id).
  const { data: orderRow } = await service
    .from("orders")
    .select("*")
    .eq("gateway_transaction_id", parsed.purchase_order_id)
    .eq("payment_gateway", "khalti")
    .single();
  const order = orderRow as Order | null;
  if (!order) {
    return NextResponse.redirect(`${APP_URL()}/checkout/return?status=not_found`);
  }

  // Idempotency: if already reconciled, just show the result.
  if (order.status === "paid") {
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=paid&order=${order.id}`,
    );
  }

  let lookup;
  try {
    lookup = await khaltiLookup(parsed.pidx);
  } catch {
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=lookup_failed&order=${order.id}`,
    );
  }

  // ── Amount check: reject any tampering. ──
  if (lookup.total_amount !== order.amount_cents) {
    await service
      .from("orders")
      .update({ status: "failed", gateway_transaction_id: parsed.purchase_order_id })
      .eq("id", order.id);
    console.error(
      `[khalti] amount mismatch order=${order.id} expected=${order.amount_cents} got=${lookup.total_amount}`,
    );
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=amount_mismatch&order=${order.id}`,
    );
  }

  // ── Pending: hold. Do not transition. ──
  if (lookup.status === "Pending" || lookup.status === "Initiated") {
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=pending&order=${order.id}`,
    );
  }

  // ── Not completed: fail. ──
  if (lookup.status !== "Completed") {
    await service
      .from("orders")
      .update({
        status: "failed",
        gateway_transaction_id: lookup.transaction_id ?? parsed.purchase_order_id,
      })
      .eq("id", order.id);
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=${encodeURIComponent(lookup.status)}&order=${order.id}`,
    );
  }

  // ── Completed: atomic stock decrement. ──
  const { data: decremented } = await service.rpc("decrement_stock", {
    p_product_id: order.product_id,
  });
  // The RPC returns the updated product row, or null if stock was already 0.
  if (!decremented) {
    // Oversold (race). Money has moved — flag for manual refund.
    await service
      .from("orders")
      .update({
        status: "failed",
        needs_refund: true,
        gateway_transaction_id: lookup.transaction_id ?? parsed.purchase_order_id,
      })
      .eq("id", order.id);
    console.error(`[khalti] oversold order=${order.id} — needs manual refund`);
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=oversold&order=${order.id}`,
    );
  }

  await service
    .from("orders")
    .update({
      status: "paid",
      gateway_transaction_id: lookup.transaction_id ?? parsed.purchase_order_id,
    })
    .eq("id", order.id);

  return NextResponse.redirect(
    `${APP_URL()}/checkout/return?status=paid&order=${order.id}`,
  );
}
