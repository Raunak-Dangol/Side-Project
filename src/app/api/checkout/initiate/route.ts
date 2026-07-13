import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { khaltiInitiate } from "@/lib/payments/khalti";
import { buildEsewaFormPayload, ESEWA_FORM_URL } from "@/lib/payments/esewa";
import { uuid } from "@/lib/utils";
import { serverEnv } from "@/lib/env/server";
import type { Product, Stream } from "@/lib/types";

const Body = z.object({
  productId: z.string().uuid(),
  streamId: z.string().uuid(),
  gateway: z.enum(["khalti", "esewa"]),
});

const APP_URL = () => serverEnv.appUrl;

/**
 * Initiates a checkout. Creates a `pending` order row with a fresh
 * transaction_uuid BEFORE redirecting the buyer, then returns either:
 *   - Khalti: { paymentUrl }  → client redirects browser there
 *   - eSewa:  { formHtml }    → client injects + auto-submits the hidden form
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

  // Amount is taken from the DB (never from the client). eSewa requires integer
  // rupees for some fields; both gateways use paisa for the actual amount.
  const amount = product.price_cents;
  const transactionUuid = uuid();

  // Insert a PENDING order via the service role (bypasses RLS).
  const service = createSupabaseServiceClient();
  const { error: insertError } = await service.from("orders").insert({
    buyer_id: user.id,
    product_id: product.id,
    stream_id: stream.id,
    payment_gateway: parsed.gateway,
    gateway_transaction_id: transactionUuid,
    status: "pending",
    amount_cents: amount,
  });
  if (insertError) {
    return NextResponse.json(
      { error: "Could not create order" },
      { status: 500 },
    );
  }

  try {
    if (parsed.gateway === "khalti") {
      const initiated = await khaltiInitiate({
        amount,
        purchaseOrderId: transactionUuid,
        purchaseOrderName: product.name,
        returnUrl: `${APP_URL()}/api/checkout/khalti/callback`,
        buyerEmail: user.email,
        buyerName: profile?.display_name ?? user.email?.split("@")[0],
      });
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
      .eq("gateway_transaction_id", transactionUuid);
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
