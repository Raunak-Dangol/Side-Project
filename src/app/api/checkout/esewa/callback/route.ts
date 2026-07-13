import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decodeEsewaCallback,
  verifyEsewaSignature,
  esewaGetStatus,
  ESEWA_PRODUCT_CODE,
} from "@/lib/payments/esewa";
import type { Order } from "@/lib/types";

const APP_URL = () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/**
 * eSewa redirect callback. Lands here with a base64 `data` param.
 *
 * Two independent checks (both required):
 *   1. Reconstruct the signed string from signed_field_names, recompute the
 *      HMAC, and timing-safe compare. This proves the payload came from eSewa.
 *   2. Call eSewa's transaction-status API. This is the defense against replay
 *      of an old valid-looking payload.
 *
 * Then: amount/product-code check, atomic stock decrement, order transition.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const dataB64 = url.searchParams.get("data");

  if (!dataB64) {
    return NextResponse.redirect(`${APP_URL()}/checkout/return?status=invalid`);
  }

  let payload;
  try {
    payload = decodeEsewaCallback(dataB64);
  } catch {
    return NextResponse.redirect(`${APP_URL()}/checkout/return?status=invalid`);
  }

  const service = createSupabaseServiceClient();

  // Find the pending order by transaction_uuid.
  const { data: orderRow } = await service
    .from("orders")
    .select("*")
    .eq("gateway_transaction_id", payload.transaction_uuid)
    .eq("payment_gateway", "esewa")
    .single();
  const order = orderRow as Order | null;
  if (!order) {
    return NextResponse.redirect(`${APP_URL()}/checkout/return?status=not_found`);
  }

  // Idempotency.
  if (order.status === "paid") {
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=paid&order=${order.id}`,
    );
  }

  // ── Check 1: signature verification (timing-safe). ──
  if (!verifyEsewaSignature(payload)) {
    await service.from("orders").update({ status: "failed" }).eq("id", order.id);
    console.error(`[esewa] signature verification failed order=${order.id}`);
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=bad_signature&order=${order.id}`,
    );
  }

  // ── Amount + product-code tamper check. ──
  const expectedAmount = String(order.amount_cents);
  if (
    (payload.total_amount && payload.total_amount !== expectedAmount) ||
    (payload.product_code && payload.product_code !== ESEWA_PRODUCT_CODE())
  ) {
    await service.from("orders").update({ status: "failed" }).eq("id", order.id);
    console.error(
      `[esewa] amount/product mismatch order=${order.id} expected_amount=${expectedAmount} got_amount=${payload.total_amount}`,
    );
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=amount_mismatch&order=${order.id}`,
    );
  }

  // ── Check 2: transaction-status API (independent of signature). ──
  let status;
  try {
    status = await esewaGetStatus({
      transactionUuid: payload.transaction_uuid,
      totalAmount: expectedAmount,
    });
  } catch {
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=lookup_failed&order=${order.id}`,
    );
  }

  if (status.status.toUpperCase() === "PENDING") {
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=pending&order=${order.id}`,
    );
  }
  if (status.status.toUpperCase() !== "COMPLETE") {
    await service.from("orders").update({ status: "failed" }).eq("id", order.id);
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=${encodeURIComponent(status.status)}&order=${order.id}`,
    );
  }

  // ── Confirmed: atomic stock decrement. ──
  const { data: decremented } = await service.rpc("decrement_stock", {
    p_product_id: order.product_id,
  });
  if (!decremented) {
    await service.from("orders").update({ status: "failed" }).eq("id", order.id);
    console.error(`[esewa] oversold order=${order.id} — needs manual refund`);
    return NextResponse.redirect(
      `${APP_URL()}/checkout/return?status=oversold&order=${order.id}`,
    );
  }

  await service
    .from("orders")
    .update({
      status: "paid",
      gateway_transaction_id: status.transaction_code ?? payload.transaction_uuid,
    })
    .eq("id", order.id);

  return NextResponse.redirect(
    `${APP_URL()}/checkout/return?status=paid&order=${order.id}`,
  );
}
