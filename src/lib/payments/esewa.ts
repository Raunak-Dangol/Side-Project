import crypto from "node:crypto";
import { serverEnv } from "@/lib/env/server";

/**
 * eSewa ePay v2 — server-side helpers.
 *
 * Unlike Khalti, this is a *signed form-submission redirect*, not a JSON API
 * call. Flow:
 *   1. Server builds a payload + HMAC-SHA256 signature over a canonical string.
 *   2. The browser auto-submits a hidden HTML form to eSewa's payment endpoint.
 *   3. Buyer pays on eSewa's page; eSewa redirects back with a base64 `data`
 *      param containing transaction_uuid, status, signed_field_names, signature.
 *   4. Server decodes the payload, reconstructs the signed string using
 *      signed_field_names, recomputes the HMAC, and timing-safe compares.
 *   5. EVEN AFTER signature verification, we call eSewa's transaction-status
 *      lookup API as an independent second confirmation (defense vs replay).
 *
 * The HMAC secret key is server-side only. `product_code` is public.
 */

const ESEWA_SECRET = () => serverEnv.esewaSecretKey;
export const ESEWA_PRODUCT_CODE = () => serverEnv.esewaProductCode;
export const ESEWA_FORM_URL = () => serverEnv.esewaFormUrl;
export const ESEWA_STATUS_URL = () => serverEnv.esewaStatusUrl;

/**
 * The canonical string eSewa signs/verifies. Fields MUST be in the exact order
 * and `field=value` format the gateway expects — eSewa integrations most
 * commonly break here.
 */
function buildSignedString(fields: string[], values: Record<string, string>) {
  return fields.map((f) => `${f}=${values[f]}`).join(",");
}

/**
 * HMAC-SHA256 of the message, base64-encoded, using the eSewa secret.
 */
function sign(message: string): string {
  const key = ESEWA_SECRET();
  if (!key) throw new Error("Missing ESEWA_SECRET_KEY");
  return crypto.createHmac("sha256", key).update(message).digest("base64");
}

export interface EsewaPaymentFieldPayload {
  amount: string;
  tax_amount: string;
  total_amount: string;
  transaction_uuid: string;
  product_code: string;
}

/**
 * Build the payload the browser form will submit to eSewa, including the
 * precomputed signature. Only public fields reach the browser; the secret key
 * never does.
 */
export function buildEsewaFormPayload(args: {
  amount: string;
  taxAmount: string;
  totalAmount: string;
  transactionUuid: string;
}): EsewaPaymentFieldPayload & { signature: string } {
  const product_code = ESEWA_PRODUCT_CODE();
  const fieldValues: EsewaPaymentFieldPayload = {
    amount: args.amount,
    tax_amount: args.taxAmount,
    total_amount: args.totalAmount,
    transaction_uuid: args.transactionUuid,
    product_code,
  };
  // eSewa signs exactly these fields, in this order:
  const signedFields = ["total_amount", "transaction_uuid", "product_code"];
  const signedString = buildSignedString(signedFields, fieldValues as unknown as Record<string, string>);
  return { ...fieldValues, signature: sign(signedString) };
}

export interface EsewaCallbackPayload {
  transaction_uuid: string;
  status: string;
  signed_field_names: string;
  signature: string;
  total_amount?: string;
  product_code?: string;
}

/**
 * Decode the base64 `data` query param eSewa redirects back with.
 */
export function decodeEsewaCallback(dataB64: string): EsewaCallbackPayload {
  const json = Buffer.from(dataB64, "base64").toString("utf8");
  return JSON.parse(json) as EsewaCallbackPayload;
}

/**
 * Verify the callback signature: reconstruct the signed string using the
 * `signed_field_names` list (NOT a hardcoded order — we trust the field list
 * but recompute the signature from the returned values), recompute the HMAC,
 * and compare using a timing-safe comparison.
 *
 * Returns true only if the signature matches. Does NOT confirm payment status —
 * the caller must still call esewaGetStatus() as a second check.
 */
export function verifyEsewaSignature(payload: EsewaCallbackPayload): boolean {
  if (!payload.signed_field_names || !payload.signature) return false;
  const fields = payload.signed_field_names.split(",");
  const values: Record<string, string> = {};
  for (const f of fields) {
    // pull each declared field from the payload
    values[f] = (payload as unknown as Record<string, string>)[f] ?? "";
  }
  const expected = sign(buildSignedString(fields, values));

  // Timing-safe comparison. Buffer.from(base64) lengths must match first.
  const a = Buffer.from(expected);
  const b = Buffer.from(payload.signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface EsewaStatusResponse {
  status: "COMPLETE" | "PENDING" | "NOT_FOUND" | string;
  ref_id?: string;
  transaction_code?: string;
  total_amount?: string;
}

/**
 * The second, independent confirmation. Pass the transaction_uuid and the
 * expected total_amount. Status must be COMPLETE for us to mark an order paid.
 */
export async function esewaGetStatus(args: {
  transactionUuid: string;
  totalAmount: string;
}): Promise<EsewaStatusResponse> {
  const url =
    `${ESEWA_STATUS_URL()}?product_code=${encodeURIComponent(ESEWA_PRODUCT_CODE())}` +
    `&total_amount=${encodeURIComponent(args.totalAmount)}` +
    `&transaction_uuid=${encodeURIComponent(args.transactionUuid)}`;

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eSewa status failed (${res.status}): ${text}`);
  }
  return (await res.json()) as EsewaStatusResponse;
}
