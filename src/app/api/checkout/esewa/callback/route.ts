import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decodeEsewaCallback,
  verifyEsewaSignature,
  esewaGetStatus,
  ESEWA_PRODUCT_CODE,
} from "@/lib/payments/esewa";
import { callFulfillOrder, fulfillRedirect } from "@/lib/payments/fulfill";
import { serverEnv } from "@/lib/env/server";
import type { Order } from "@/lib/types";

const APP_URL = () => serverEnv.appUrl;
const redirect = (path: string) => NextResponse.redirect(`${APP_URL()}${path}`);

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
    return redirect(`/checkout/return?status=invalid`);
  }

  let payload;
  try {
    payload = decodeEsewaCallback(dataB64);
  } catch {
    return redirect(`/checkout/return?status=invalid`);
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
    return redirect(`/checkout/return?status=not_found`);
  }

  // Idempotency.
  if (order.status === "paid") {
    return redirect(`/checkout/return?status=paid&orderId=${order.id}`);
  }

  // ── Check 1: signature verification (timing-safe). ──
  if (!verifyEsewaSignature(payload)) {
    await service.from("orders").update({ status: "failed" }).eq("id", order.id);
    console.error(`[esewa] signature verification failed order=${order.id}`);
    return redirect(`/checkout/return?status=bad_signature&orderId=${order.id}`);
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
    return redirect(`/checkout/return?status=amount_mismatch&orderId=${order.id}`);
  }

  // ── Check 2: transaction-status API (independent of signature). ──
  let status;
  try {
    status = await esewaGetStatus({
      transactionUuid: payload.transaction_uuid,
      totalAmount: expectedAmount,
    });
  } catch {
    return redirect(`/checkout/return?status=lookup_failed&orderId=${order.id}`);
  }

  if (status.status.toUpperCase() === "PENDING") {
    return redirect(`/checkout/return?status=pending&orderId=${order.id}`);
  }
  if (status.status.toUpperCase() !== "COMPLETE") {
    await service.from("orders").update({ status: "failed" }).eq("id", order.id);
    return redirect(`/checkout/return?status=${encodeURIComponent(status.status)}&orderId=${order.id}`);
  }

  // ── Confirmed: atomic fulfillment ──
  const { outcome } = await callFulfillOrder(service, {
    orderId: order.id,
    transactionId: status.transaction_code ?? payload.transaction_uuid,
  });

  return NextResponse.redirect(fulfillRedirect(outcome, order.id));
}
