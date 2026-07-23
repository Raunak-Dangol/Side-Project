import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { khaltiInitiate } from "@/lib/payments/khalti";
import { buildEsewaFormPayload, ESEWA_FORM_URL } from "@/lib/payments/esewa";
import { uuid } from "@/lib/utils";
import { serverEnv } from "@/lib/env/server";
import type { Product, ShippingAddress, Stream } from "@/lib/types";

const AddressSchema = z
  .object({
    name: z.string().min(1).max(120),
    phone: z.string().min(1).max(40),
    line1: z.string().min(1).max(300),
    city: z.string().min(1).max(120),
  })
  .nullable()
  .optional();

const Body = z.object({
  productId: z.string().uuid(),
  streamId: z.string().uuid(),
  gateway: z.enum(["khalti", "esewa"]),
  /** Phase 3 §4: quantity (1-99, clamped). Defaults to 1 for legacy clients. */
  quantity: z.number().int().min(1).max(99).default(1),
  /** Phase 3 §4: optional shipping address. Null/undefined = no shipping. */
  shippingAddress: AddressSchema,
});

const APP_URL = () => serverEnv.appUrl;
const MAX_QTY = 99;

/**
 * Initiates a checkout. Creates a `pending` order row with a fresh
 * transaction_uuid BEFORE redirecting the buyer, then returns either:
 *   - Khalti: { paymentUrl }  -> client redirects browser there
 *   - eSewa:  { formHtml }    -> client injects + auto-submits the hidden form
 *
 * Phase 3 §4 — qty + address:
 *   - Accepts `quantity` (1-99) and an optional `shippingAddress`.
 *   - Amount is SERVER-AUTHORITATIVE: `product.price_cents * quantity`, never
 *     read from the client. The same amount flows to Khalti/eSewa and is stored
 *     on the order, so the callback's amount-tamper check still holds.
 *   - Quantity is persisted so `fulfill_order` can decrement stock by it (the
 *     RPC was upgraded in 0009 to decrement by `quantity`).
 *
 * The order is inserted via the SERVICE ROLE client (RLS would otherwise deny
 * client-side inserts on `orders` by design — only the server creates orders).
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
    return NextResponse.json({ error: "Sign in to buy" }, { status: 401 });
  }

  // Fetch the product and stream to validate + lock the amount server-side.
  const { data: productRow } = await supabase
    .from("products")
    .select("*")
    .eq("id", parsed.productId)
    .single();
  const product = productRow as Product | null;
  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }
  if (product.stock <= 0) {
    return NextResponse.json({ error: "Sold out" }, { status: 409 });
  }
  // Defend against a qty exceeding available stock at initiation. (A race can
  // still deplete stock between initiate and fulfillment — that's the
  // `oversold` path handled by fulfill_order.)
  const quantity = Math.min(parsed.quantity, MAX_QTY, product.stock);
  if (quantity < 1) {
    return NextResponse.json({ error: "Sold out" }, { status: 409 });
  }

  const { data: streamRow } = await supabase
    .from("streams")
    .select("*")
    .eq("id", parsed.streamId)
    .single();
  const stream = streamRow as Stream | null;
  if (!stream) {
    return NextResponse.json({ error: "Stream not found" }, { status: 404 });
  }

  // Fetch buyer display name (Khalti requires customer_info.name).
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .single();

  // Amount is taken from the DB (never from the client) and now reflects qty.
  // Integer paisa throughout; both gateways use paisa for the actual amount.
  const amount = product.price_cents * quantity;
  // eSewa still needs a client-side transaction UUID for its signed payload.
  // Khalti no longer uses this — it uses the persisted order.id as
  // purchase_order_id (see the Khalti branch below).
  const transactionUuid = uuid();

  // Normalize the shipping address to a plain object the DB accepts, or null.
  const shippingAddress: ShippingAddress | null = parsed.shippingAddress ?? null;

  // Insert a PENDING order via the service role (bypasses RLS).
  // gateway_transaction_id is left NULL for Khalti orders — it is set ONLY when
  // fulfill_order binds Khalti's authoritative transaction_id. (eSewa still
  // uses the transactionUuid as its reference, stored here for its callback.)
  const service = createSupabaseServiceClient();
  const { data: insertedRow, error: insertError } = await service
    .from("orders")
    .insert({
      buyer_id: user.id,
      product_id: product.id,
      stream_id: stream.id,
      payment_gateway: parsed.gateway,
      gateway_transaction_id: parsed.gateway === "esewa" ? transactionUuid : null,
      status: "pending",
      amount_cents: amount,
      quantity,
      // Cast through unknown: db-types models jsonb as Record<string, unknown>,
      // but our ShippingAddress is a typed shape. The runtime value is the same.
      shipping_address: shippingAddress as unknown as Record<string, unknown> | null,
    })
    .select("id")
    .single();
  if (insertError || !insertedRow) {
    return NextResponse.json(
      { error: "Could not create order" },
      { status: 500 },
    );
  }
  const orderId = insertedRow.id;

  try {
    if (parsed.gateway === "khalti") {
      const returnUrl = `${APP_URL()}/api/checkout/khalti/callback`;
      console.log(`[khalti-initiate] APP_URL=${APP_URL()} returnUrl=${returnUrl} orderId=${orderId}`);
      // purchase_order_id = the persisted order.id. This is the authoritative
      // mapping: Khalti echoes it back in the lookup response, and the callback
      // finds the order by orders.id = purchase_order_id. No fake/pre-payment
      // gateway_transaction_id is generated for Khalti orders.
      const initiated = await khaltiInitiate({
        amount,
        purchaseOrderId: orderId,
        purchaseOrderName: quantity > 1 ? `${product.name} x${quantity}` : product.name,
        returnUrl,
        buyerEmail: user.email,
        buyerName: profile?.display_name ?? user.email?.split("@")[0],
      });
      // Bind the pidx Khalti issued to this order BEFORE redirecting, so the
      // callback can always find the order by pidx (blocks pidx replay against
      // a different order — audit finding H1). If this persistence fails, we do
      // NOT redirect — the buyer would land on a callback that can't find the
      // order. Mark the order failed so it's not left dangling.
      const { error: pidxError } = await service
        .from("orders")
        .update({ khalti_pidx: initiated.pidx })
        .eq("id", orderId);
      if (pidxError) {
        console.error(`[khalti-initiate] pidx persistence failed order=${orderId}`, pidxError.message);
        await service.from("orders").update({ status: "failed" }).eq("id", orderId);
        return NextResponse.json(
          { error: "Could not bind payment session" },
          { status: 500 },
        );
      }
      return NextResponse.json({ paymentUrl: initiated.payment_url });
    }

    // eSewa: build the signed payload + a hidden auto-submitting form.
    const amountStr = String(amount);
    const payload = buildEsewaFormPayload({
      amount: amountStr,
      taxAmount: "0",
      totalAmount: amountStr,
      transactionUuid,
    });
    const formHtml = renderEsewaForm(payload);
    return NextResponse.json({ formHtml });
  } catch (e) {
    // Gateway call failed; mark the order failed so it isn't left dangling.
    await service
      .from("orders")
      .update({ status: "failed" })
      .eq("id", orderId);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Gateway error" },
      { status: 502 },
    );
  }
}

function renderEsewaForm(p: ReturnType<typeof buildEsewaFormPayload>): string {
  // Hidden form auto-submitted on inject. field order matches eSewa's spec.
  return `
    <form id="esewa-payment-form" action="${ESEWA_FORM_URL()}" method="POST">
      <input type="hidden" name="amount" value="${p.amount}" />
      <input type="hidden" name="tax_amount" value="${p.tax_amount}" />
      <input type="hidden" name="total_amount" value="${p.total_amount}" />
      <input type="hidden" name="transaction_uuid" value="${p.transaction_uuid}" />
      <input type="hidden" name="product_code" value="${p.product_code}" />
      <input type="hidden" name="signature" value="${p.signature}" />
    </form>
  `;
}
