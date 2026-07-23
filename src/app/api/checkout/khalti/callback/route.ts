import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { khaltiLookup } from "@/lib/payments/khalti";
import { serverEnv } from "@/lib/env/server";
import type { Order } from "@/lib/types";

const Query = z.object({
  pidx: z.string().min(1),
  status: z.string().optional(),
  transaction_id: z.string().optional(),
  purchase_order_id: z.string().min(1),
});

const APP_URL = () => serverEnv.appUrl;
const redirect = (path: string) => NextResponse.redirect(`${APP_URL()}${path}`);

/**
 * Khalti redirect callback. The buyer lands here with query params after
 * paying (or cancelling). We NEVER trust these params as confirmation — we
 * immediately call the Khalti LOOKUP API with `pidx` to get the authoritative
 * status, then reconcile.
 *
 * ── Identifier mapping (corrected) ──
 *   Khalti purchase_order_id  = persisted orders.id (sent at initiate)
 *   Khalti pidx               = orders.khalti_pidx (bound at initiate)
 *   Khalti transaction_id     = orders.gateway_transaction_id (set by
 *                              fulfill_order on success — null until then)
 *
 * ── Order lookup (three axes, in priority order) ──
 *   1. Primary:   orders.id = purchase_order_id  (new mapping)
 *   2. Fallback:  orders.khalti_pidx = pidx       (unique; always works if
 *                 pidx was persisted at initiate)
 *   3. Legacy:    orders.gateway_transaction_id = purchase_order_id  (old
 *                 mapping where a pre-payment UUID was stored). Only accepted
 *                 if the pidx also matches — the fake UUID alone is not
 *                 enough to reconcile.
 *
 * ── Reconciliation rules ──
 *   - Completed + amount match → fulfill_order (atomic, idempotent)
 *   - Pending / Initiated      → hold (no state change)
 *   - Expired / canceled / etc → mark failed
 *   - Amount mismatch          → mark failed (tamper protection)
 *   - pidx mismatch             → mark failed (replay protection)
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  let parsed: z.infer<typeof Query>;
  try {
    parsed = Query.parse(Object.fromEntries(url.searchParams.entries()));
  } catch {
    return redirect(`/checkout/return?status=invalid`);
  }

  const service = createSupabaseServiceClient();

  // ── Order lookup: primary axis = orders.id = purchase_order_id ──────────
  let order: Order | null = null;

  // Validate purchase_order_id as a UUID for the primary lookup.
  const poiIsUuid = z.string().uuid().safeParse(parsed.purchase_order_id).success;
  if (poiIsUuid) {
    const { data: row } = await service
      .from("orders")
      .select("*")
      .eq("id", parsed.purchase_order_id)
      .eq("payment_gateway", "khalti")
      .maybeSingle();
    order = (row as Order | null) ?? null;
  }

  // ── Fallback: unique khalti_pidx axis ──────────────────────────────────
  // Works for both new and legacy orders — pidx is unique per Khalti session
  // and was persisted at initiate before the redirect.
  if (!order) {
    const { data: byPidx } = await service
      .from("orders")
      .select("*")
      .eq("khalti_pidx", parsed.pidx)
      .eq("payment_gateway", "khalti")
      .maybeSingle();
    order = (byPidx as Order | null) ?? null;
  }

  // ── Legacy fallback: gateway_transaction_id = purchase_order_id ────────
  // Old initiate code stored a pre-payment UUID in gateway_transaction_id and
  // sent it as purchase_order_id. Accept it ONLY if pidx matches too — the
  // fake UUID alone is insufficient proof.
  if (!order) {
    const { data: byLegacy } = await service
      .from("orders")
      .select("*")
      .eq("gateway_transaction_id", parsed.purchase_order_id)
      .eq("payment_gateway", "khalti")
      .maybeSingle();
    const legacy = (byLegacy as Order | null) ?? null;
    if (legacy && legacy.khalti_pidx === parsed.pidx) {
      order = legacy;
    }
  }

  if (!order) {
    return redirect(`/checkout/return?status=not_found`);
  }

  // ── pidx binding verification ──────────────────────────────────────────
  // If the order already has a pidx bound (from initiate), it MUST match the
  // callback's pidx. A mismatch means someone is replaying a different pidx
  // against this order.
  if (order.khalti_pidx && order.khalti_pidx !== parsed.pidx) {
    await service.from("orders").update({ status: "failed" }).eq("id", order.id);
    console.error(
      `[khalti] pidx mismatch order=${order.id} bound=${order.khalti_pidx} callback=${parsed.pidx}`,
    );
    return redirect(`/checkout/return?status=amount_mismatch&order=${order.id}`);
  }

  // Idempotency: if already reconciled, just show the result.
  if (order.status === "paid") {
    return redirect(`/checkout/return?status=paid&order=${order.id}`);
  }

  // ── Authoritative lookup ───────────────────────────────────────────────
  let lookup;
  try {
    lookup = await khaltiLookup(parsed.pidx);
  } catch {
    return redirect(`/checkout/return?status=lookup_failed&order=${order.id}`);
  }

  console.log(`[khalti-callback] lookup order=${order.id} status=${lookup.status} amount=${lookup.total_amount} expected=${order.amount_cents} hasTxnId=${Boolean(lookup.transaction_id)}`);

  // ── H1: verify the payment is for THIS order via purchase_order_id ─────
  // The lookup echoes back the purchase_order_id we sent at initiate. For new
  // orders that's orders.id; for legacy orders it's the old gateway_transaction_id.
  if (lookup.purchase_order_id && lookup.purchase_order_id !== parsed.purchase_order_id) {
    await service.from("orders").update({ status: "failed" }).eq("id", order.id);
    console.error(
      `[khalti] purchase_order_id mismatch order=${order.id} callback=${parsed.purchase_order_id} lookup=${lookup.purchase_order_id}`,
    );
    return redirect(`/checkout/return?status=amount_mismatch&order=${order.id}`);
  }

  // ── Amount check: reject any tampering. ──
  if (lookup.total_amount !== order.amount_cents) {
    await service.from("orders").update({ status: "failed" }).eq("id", order.id);
    console.error(
      `[khalti] amount mismatch order=${order.id} expected=${order.amount_cents} got=${lookup.total_amount}`,
    );
    return redirect(`/checkout/return?status=amount_mismatch&order=${order.id}`);
  }

  // ── Pending: hold. Do not transition. ──
  if (lookup.status === "Pending" || lookup.status === "Initiated") {
    return redirect(`/checkout/return?status=pending&order=${order.id}`);
  }

  // ── Not completed: fail. ──
  if (lookup.status !== "Completed") {
    await service.from("orders").update({ status: "failed" }).eq("id", order.id);
    return redirect(`/checkout/return?status=${encodeURIComponent(lookup.status)}&order=${order.id}`);
  }

  // ── Completed: require a real transaction_id ──
  if (!lookup.transaction_id) {
    console.error(`[khalti] completed but no transaction_id order=${order.id}`);
    return redirect(`/checkout/return?status=lookup_failed&order=${order.id}`);
  }

  // ── Atomic fulfillment ──────────────────────────────────────────────────
  // fulfill_order locks the order row, checks status (idempotent), binds pidx,
  // decrements stock, and stores the real Khalti transaction_id as
  // gateway_transaction_id (replacing any legacy fake UUID).
  const { data: result } = await service.rpc("fulfill_order", {
    p_order: order.id,
    p_transaction_id: lookup.transaction_id,
    p_khalti_pidx: parsed.pidx,
  });
  const outcome = (result as string | null) ?? "not_found";

  if (outcome === "oversold") {
    console.error(`[khalti] oversold order=${order.id} — needs manual refund`);
    return redirect(`/checkout/return?status=oversold&order=${order.id}`);
  }
  if (outcome === "not_found") {
    return redirect(`/checkout/return?status=not_found`);
  }

  // 'paid' (this callback) or 'already_handled' (a prior callback already paid
  // it) — either way the buyer sees a success page with the internal order ID.
  return redirect(`/checkout/return?status=paid&order=${order.id}`);
}
