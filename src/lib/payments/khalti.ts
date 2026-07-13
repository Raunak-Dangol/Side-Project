/**
 * Khalti KPG ePayment v2 — server-side helpers.
 *
 * Flow: initiate → redirect buyer to payment_url → buyer pays → Khalti
 * redirects back to our return URL with query params → we call the lookup API
 * with the returned `pidx` to get the authoritative status.
 *
 * All calls use `Authorization: Key <secret>`. The secret is server-side only.
 */

import { serverEnv } from "@/lib/env";

const KHALTI_BASE = () => serverEnv.khaltiBaseUrl;
const KHALTI_SECRET = () => serverEnv.khaltiSecretKey;

/** Builds the `Authorization: Key <secret>` header used by all Khalti calls. */
export function authHeader() {
  const key = KHALTI_SECRET();
  if (!key) throw new Error("Missing KHALTI_SECRET_KEY");
  return { Authorization: `Key ${key}`, "Content-Type": "application/json" };
}

export interface KhaltiInitiateParams {
  /** amount in paisa (NPR * 100) */
  amount: number;
  purchaseOrderId: string;
  purchaseOrderName: string;
  returnUrl: string;
  buyerName?: string;
  buyerEmail?: string;
}

export interface KhaltiInitiateResponse {
  pidx: string;
  payment_url: string;
  expires_at?: string | null;
  expires_in?: number | null;
}

/** Step 1 — initiate the payment and get a payment_url + pidx. */
export async function khaltiInitiate(
  params: KhaltiInitiateParams,
): Promise<KhaltiInitiateResponse> {
  const res = await fetch(`${KHALTI_BASE()}/api/v2/epay/initiate/`, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify({
      return_url: params.returnUrl,
      website_url: serverEnv.appUrl,
      amount: params.amount,
      purchase_order_id: params.purchaseOrderId,
      purchase_order_name: params.purchaseOrderName,
      ...(params.buyerName ? { customer_info: { name: params.buyerName } } : {}),
      ...(params.buyerEmail ? { customer_info: { email: params.buyerEmail } } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Khalti initiate failed (${res.status}): ${text}`);
  }
  return (await res.json()) as KhaltiInitiateResponse;
}

/** Authoritative status values from the Khalti lookup response. */
export type KhaltiStatus =
  | "Completed"
  | "Pending"
  | "Expired"
  | "User canceled"
  | "Refunded"
  // (defensive — Khalti may surface these in some payloads)
  | "Initiated"
  | "Unknown";

export interface KhaltiLookupResponse {
  pidx: string;
  total_amount: number;
  status: KhaltiStatus;
  purchase_order_id?: string;
  purchase_order_name?: string;
  transaction_id?: string;
}

/**
 * Step 2 — the SOLE source of truth. Call this with the `pidx` returned in the
 * redirect query params. Never mark an order paid from the redirect alone.
 */
export async function khaltiLookup(
  pidx: string,
): Promise<KhaltiLookupResponse> {
  const res = await fetch(`${KHALTI_BASE()}/api/v2/epay/transactions/lookup/`, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify({ pidx }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Khalti lookup failed (${res.status}): ${text}`);
  }
  return (await res.json()) as KhaltiLookupResponse;
}
