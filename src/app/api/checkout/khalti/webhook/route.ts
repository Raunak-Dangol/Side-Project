import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { khaltiLookup } from "@/lib/payments/khalti";
import { serverEnv } from "@/lib/env/server";
import type { Order } from "@/lib/types";

/**
 * Khalti webhook (§9.B). ADDITIVE to the redirect callback — when Khalti fires a
 * server-to-server payment-status event for a `Completed` payment that lost its
 * browser redirect (buyer closed the tab, network blip), this route reconciles
 * the order so it stops stranding at `pending`.
 *
 * Auth: Khalti webhook verification is signed via the optional
 * `KHALTI_WEBHOOK_SECRET` env var. When that var is unset, this route 503s — the
 * webhook is DISABLED in that env, so Khalti shouldn't be pointed at it yet.
 * When it IS set, Khalti is expected to send the secret as a header or query
 * param (the exact channel is gateway-specific — we check both `Authorization`
 * and `x-khalti-signature`).
 *
 * Reconciliation reuses the SAME primitives as the redirect callback:
 *   `khaltiLookup(pidx)` → authoritative status → `fulfill_order` (row-locked,
 * idempotent RPC). This means calling this route is SAFE to do in addition to the
 * redirect callback — `fulfill_order`'s status check prevents double-transition
 * either way.
 */
const Body = z.object({
  pidx: z.string().min(1),
  // Some Khalti payloads echo these; we only need pidx because we lookup.
  purchase_order_id: z.string().optional(),
  status: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const webhookSecret = serverEnv.khaltiWebhookSecret;
  if (!webhookSecret) {
    // Webhook not configured for this env — Khalti shouldn't be calling here.
    return NextResponse.json({ error: "Webhook disabled" }, { status: 503 });
  }

  // ── Verify the caller knows our shared secret. Khalti's exact channel varies
  // by integration tier; accept it from either the Authorization header or a
  // dedicated signature header. Timing-safe compare to avoid an oracle.
  const authHeader = request.headers.get("authorization") ?? "";
  const sigHeader = request.headers.get("x-khalti-signature") ?? "";
  const candidate = sigHeader || authHeader.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(webhookSecret);
  const b = Buffer.from(candidate);
  const secretOk =
    a.length === b.length &&
    a.length > 0 &&
    crypto.timingSafeEqual(a, b);
  if (!secretOk) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const service = createSupabaseServiceClient();

  let lookup;
  try {
    lookup = await khaltiLookup(parsed.pidx);
  } catch (e) {
    console.error("[khalti-webhook] lookup failed", e);
    return NextResponse.json({ error: "Lookup failed" }, { status: 502 });
  }

  // Only reconcile terminal Completed payments. Pending/Initiated are not
  // actionable from this webhook.
  if (lookup.status !== "Completed") {
    return NextResponse.json({ ok: true, status: lookup.status, skipped: true });
  }

  // Find the order by the pidx we bound at initiation (the H1 replay-block
  // binding). The lookup's purchase_order_id must match our
  // gateway_transaction_id — same anti-replay guard as the redirect callback.
  const { data: orderRow } = await service
    .from("orders")
    .select("id, gateway_transaction_id, amount_cents, status, khalti_pidx")
    .eq("khalti_pidx", parsed.pidx)
    .eq("payment_gateway", "khalti")
    .maybeSingle();
  const order = orderRow as
    | Pick<Order, "id" | "gateway_transaction_id" | "amount_cents" | "status" | "khalti_pidx">
    | null;
  if (!order) {
    // Unknown pidx — Khalti may be probing or the order was never initiated
    // through us. ACK so Khalti stops retrying; log for investigation.
    console.warn(`[khalti-webhook] unknown pidx=${parsed.pidx}`);
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Anti-replay: pidx must still belong to THIS order.
  if (
    lookup.purchase_order_id &&
    lookup.purchase_order_id !== order.gateway_transaction_id
  ) {
    console.error(
      `[khalti-webhook] replay rejected order=${order.id} expected=${order.gateway_transaction_id} lookup=${lookup.purchase_order_id}`,
    );
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Amount tamper check — same guard as the redirect callback.
  if (lookup.total_amount !== order.amount_cents) {
    console.error(
      `[khalti-webhook] amount mismatch order=${order.id} expected=${order.amount_cents} got=${lookup.total_amount}`,
    );
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Atomic, idempotent fulfillment. If the redirect callback already paid it,
  // `already_handled` is returned — both paths are safe to coexist.
  const { data: result } = await service.rpc("fulfill_order", {
    p_order: order.id,
    p_transaction_id: lookup.transaction_id ?? order.gateway_transaction_id,
    p_khalti_pidx: parsed.pidx,
  });
  const outcome = (result as string | null) ?? "not_found";
  if (outcome === "oversold") {
    console.error(`[khalti-webhook] oversold order=${order.id} — needs manual refund`);
  }

  return NextResponse.json({ ok: true, outcome });
}
