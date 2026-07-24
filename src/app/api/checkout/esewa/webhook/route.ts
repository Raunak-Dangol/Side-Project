import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  verifyEsewaSignature,
  esewaGetStatus,
  ESEWA_PRODUCT_CODE,
  type EsewaCallbackPayload,
} from "@/lib/payments/esewa";
import { callFulfillOrder } from "@/lib/payments/fulfill";
import { serverEnv } from "@/lib/env/server";
import type { Order } from "@/lib/types";

/**
 * eSewa webhook (§9.B). ADDITIVE to the redirect callback — reconciles a
 * `COMPLETE` payment that lost its browser redirect so the order stops stranding
 * at `pending`. Same dual-check as the redirect callback (signature verify +
 * status API) plus a shared-secret gate so only eSewa can call this route.
 *
 * Reuses `verifyEsewaSignature` and `esewaGetStatus` from the esewa payment
 * lib, then the same idempotent `fulfill_order` RPC the redirect callback uses
 * — so calling both paths is safe (the second one returns `already_handled`).
 */
const Body = z.object({
  // eSewa echoes the base64 `data` blob (same as the redirect callback) or, in
  // some webhook flavors, the decoded fields directly. We support both.
  data: z.string().optional(),
  transaction_uuid: z.string().optional(),
  status: z.string().optional(),
  total_amount: z.string().optional(),
  signed_field_names: z.string().optional(),
  signature: z.string().optional(),
  product_code: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const webhookSecret = serverEnv.esewaWebhookSecret;
  if (!webhookSecret) {
    return NextResponse.json({ error: "Webhook disabled" }, { status: 503 });
  }

  // ── Shared-secret verification. eSewa's exact channel varies; accept the
  // secret from the Authorization header or a dedicated signature header.
  const authHeader = request.headers.get("authorization") ?? "";
  const sigHeader = request.headers.get("x-esewa-signature") ?? "";
  const candidate = sigHeader || authHeader.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(webhookSecret);
  const b = Buffer.from(candidate);
  const secretOk =
    a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  if (!secretOk) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Normalize to an EsewaCallbackPayload regardless of which flavor eSewa sent.
  let payload: EsewaCallbackPayload;
  if (parsed.data) {
    try {
      payload = decodeBase64Data(parsed.data);
    } catch {
      return NextResponse.json({ error: "Invalid data" }, { status: 400 });
    }
  } else if (parsed.transaction_uuid) {
    payload = {
      transaction_uuid: parsed.transaction_uuid,
      status: parsed.status ?? "",
      signed_field_names: parsed.signed_field_names ?? "",
      signature: parsed.signature ?? "",
      total_amount: parsed.total_amount,
      product_code: parsed.product_code,
    };
  } else {
    return NextResponse.json({ error: "Missing transaction id" }, { status: 400 });
  }

  const service = createSupabaseServiceClient();

  // Find the pending order by transaction_uuid.
  const { data: orderRow } = await service
    .from("orders")
    .select("id, gateway_transaction_id, amount_cents, status")
    .eq("gateway_transaction_id", payload.transaction_uuid)
    .eq("payment_gateway", "esewa")
    .maybeSingle();
  const order = orderRow as
    | Pick<Order, "id" | "gateway_transaction_id" | "amount_cents" | "status">
    | null;
  if (!order) {
    console.warn(`[esewa-webhook] unknown transaction_uuid=${payload.transaction_uuid}`);
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Idempotency — already paid via the redirect callback.
  if (order.status === "paid") {
    return NextResponse.json({ ok: true, outcome: "already_handled" });
  }

  // ── Check 1: signature (only when eSewa sent one). ──
  if (payload.signed_field_names && payload.signature) {
    if (!verifyEsewaSignature(payload)) {
      console.error(`[esewa-webhook] signature verification failed order=${order.id}`);
      return NextResponse.json({ ok: true, skipped: true });
    }
  }

  // ── Amount/product-code tamper check. ──
  const expectedAmount = String(order.amount_cents);
  if (
    (payload.total_amount && payload.total_amount !== expectedAmount) ||
    (payload.product_code && payload.product_code !== ESEWA_PRODUCT_CODE())
  ) {
    console.error(
      `[esewa-webhook] amount/product mismatch order=${order.id} expected=${expectedAmount} got=${payload.total_amount}`,
    );
    return NextResponse.json({ ok: true, skipped: true });
  }

  // ── Check 2: authoritative status API (independent of signature). ──
  let status;
  try {
    status = await esewaGetStatus({
      transactionUuid: payload.transaction_uuid,
      totalAmount: expectedAmount,
    });
  } catch (e) {
    console.error("[esewa-webhook] status lookup failed", e);
    return NextResponse.json({ error: "Status lookup failed" }, { status: 502 });
  }

  if (status.status.toUpperCase() === "PENDING") {
    return NextResponse.json({ ok: true, status: "PENDING", skipped: true });
  }
  if (status.status.toUpperCase() !== "COMPLETE") {
    return NextResponse.json({ ok: true, status: status.status, skipped: true });
  }

  // Atomic, idempotent fulfillment.
  const { outcome } = await callFulfillOrder(service, {
    orderId: order.id,
    transactionId: status.transaction_code ?? order.gateway_transaction_id,
  });
  if (outcome === "oversold") {
    console.error(`[esewa-webhook] oversold order=${order.id} — needs manual refund`);
  }

  return NextResponse.json({ ok: true, outcome });
}

function decodeBase64Data(dataB64: string): EsewaCallbackPayload {
  const json = Buffer.from(dataB64, "base64").toString("utf8");
  return JSON.parse(json) as EsewaCallbackPayload;
}
