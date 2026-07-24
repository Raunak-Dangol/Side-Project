import type { SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env/server";

/**
 * Shared payment fulfillment helpers.
 *
 * `fulfill_order` is a PostgREST RPC with the EXACT production signature:
 *
 *   public.fulfill_order(
 *     p_order uuid,
 *     p_transaction_id text,
 *     p_khalti_pidx text
 *   ) returns text
 *
 * PostgREST matches RPC functions by EXACT parameter name. The parameter is
 * `p_order` (NOT `p_order_id`). A mismatch silently fails resolution and the
 * RPC returns null — which used to be misclassified as `not_found`.
 *
 * Return strings (scalar text, documented in the migration):
 *   - "paid"           → order transitioned pending→paid, stock decremented
 *   - "already_handled" → order was already paid/failed (idempotent replay)
 *   - "oversold"       → stock was insufficient; order marked failed+needs_refund
 *   - "not_found"      → the p_order uuid didn't match any order row
 */

export type FulfillOutcome =
  | "paid"
  | "already_handled"
  | "oversold"
  | "not_found"
  | "error";

export interface FulfillParams {
  orderId: string;
  transactionId: string | null;
  khaltiPidx?: string | null;
}

export interface FulfillResult {
  outcome: FulfillOutcome;
  error?: {
    code: string | null;
    message: string | null;
    details: string | null;
    hint: string | null;
  };
}

/**
 * Calls the `fulfill_order` RPC with the EXACT parameter names the production
 * function expects. Adds sanitized before/after logging. Never throws —
 * returns a typed outcome so callers can classify redirects correctly.
 */
export async function callFulfillOrder(
  service: SupabaseClient,
  params: FulfillParams,
): Promise<FulfillResult> {
  const { orderId, transactionId, khaltiPidx } = params;

  console.info("[payment] fulfill_start", {
    orderId,
    hasTransactionId: Boolean(transactionId),
    hasPidx: Boolean(khaltiPidx),
  });

  const { data, error } = await service.rpc("fulfill_order", {
    p_order: orderId,
    p_transaction_id: transactionId,
    p_khalti_pidx: khaltiPidx ?? null,
  });

  console.info("[payment] fulfill_result", {
    orderId,
    hasError: Boolean(error),
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    errorDetails: error?.details ?? null,
    errorHint: error?.hint ?? null,
    result: data,
  });

  if (error) {
    return {
      outcome: "error",
      error: {
        code: error.code ?? null,
        message: error.message ?? null,
        details: error.details ?? null,
        hint: error.hint ?? null,
      },
    };
  }

  // The RPC returns scalar text. PostgREST may return it as a string or,
  // depending on the client version, wrapped. Normalize to string.
  const raw = typeof data === "string" ? data : String(data ?? "");
  if (raw === "paid" || raw === "already_handled" || raw === "oversold" || raw === "not_found") {
    return { outcome: raw };
  }

  // Unknown/null result — treat as error, never as not_found (the order was
  // already found by the caller; a null RPC result is an RPC problem, not a
  // missing-order problem).
  return {
    outcome: "error",
    error: {
      code: null,
      message: `Unexpected RPC result: ${raw || "(null)"}`,
      details: null,
      hint: null,
    },
  };
}

/**
 * Maps a fulfill outcome to the standardized checkout-return redirect URL.
 * Uses `orderId` (not `order`) as the query parameter name.
 */
export function fulfillRedirect(outcome: FulfillOutcome, orderId: string): string {
  const base = serverEnv.appUrl;
  switch (outcome) {
    case "paid":
    case "already_handled":
      return `${base}/checkout/return?status=paid&orderId=${orderId}`;
    case "oversold":
      return `${base}/checkout/return?status=oversold&orderId=${orderId}`;
    case "not_found":
      return `${base}/checkout/return?status=not_found`;
    case "error":
    default:
      return `${base}/checkout/return?status=error&orderId=${orderId}`;
  }
}
