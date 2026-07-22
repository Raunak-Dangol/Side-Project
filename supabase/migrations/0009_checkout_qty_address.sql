-- =============================================================================
-- Live Shop — Phase 3 §4: quantity + shipping address on orders.
--
-- Adds `quantity` (positive integer, default 1) and `shipping_address` (jsonb,
-- nullable) to the orders table, and upgrades `fulfill_order` to decrement
-- stock by the order's quantity (instead of always 1).
--
-- Backward-compatible:
--   - Existing orders backfill to quantity=1, so historical rows stay consistent
--     with the prior single-unit fulfillment behavior.
--   - fulfill_order's new stock check is `stock >= quantity` instead of
--     `stock > 0`; for quantity=1 these are equivalent, so legacy orders
--     fulfill exactly as before.
--   - The callback routes are unchanged — they still call fulfill_order with
--     the same signature; the RPC reads quantity off the locked order row.
--
-- The initiate route (TypeScript) computes amount = product.price_cents *
-- quantity server-side, so amount_cents already reflects the qty on the row
-- fulfill_order reads. No amount-side change needed here.
-- =============================================================================

alter table public.orders
  add column if not exists quantity integer not null default 1;

-- Enforce positivity. Existing rows already satisfy this (default 1).
do $$ begin
  alter table public.orders
    add constraint orders_quantity_check check (quantity > 0);
exception when duplicate_object then null; end $$;

-- Optional shipping address. Stored as jsonb (name/phone/line1/city). Nullable
-- because some products may be digital / pick-up only and the seller can follow
-- up via the order dashboard.
alter table public.orders
  add column if not exists shipping_address jsonb;

-- =============================================================================
-- fulfill_order (v2): qty-aware stock decrement.
--
-- Same idempotency + row-lock guarantees as v1, but now decrements by the
-- order's `quantity` and only succeeds if the product has at least that much
-- stock. For quantity=1 the behavior is identical to v1.
-- =============================================================================
create or replace function public.fulfill_order(
  p_order uuid,
  p_transaction_id text default null,
  p_khalti_pidx text default null
)
returns text  -- 'paid' | 'oversold' | 'already_handled' | 'not_found'
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_product public.products;
  v_qty integer;
begin
  -- Lock the order row. A second callback blocks here until the first commits,
  -- then re-reads status and sees 'paid' -> no-op. This is the H2 fix.
  select * into v_order
    from public.orders
   where id = p_order
   for update;

  if not found then
    return 'not_found';
  end if;

  -- Idempotency: don't double-process.
  if v_order.status in ('paid', 'failed') then
    return 'already_handled';
  end if;

  -- Bind the pidx if provided (H1).
  if p_khalti_pidx is not null and v_order.khalti_pidx is null then
    update public.orders
       set khalti_pidx = p_khalti_pidx
     where id = p_order and khalti_pidx is null;
  end if;

  v_qty := coalesce(v_order.quantity, 1);

  -- Atomic decrement under the product row lock: succeed only if enough stock.
  select * into v_product
    from public.products
   where id = v_order.product_id and stock >= v_qty
   for update of public.products;
  if found then
    update public.products
       set stock = stock - v_qty
     where id = v_order.product_id
    returning * into v_product;
  else
    v_product := null;
  end if;

  if v_product is null then
    -- Oversold race: payment completed but stock is insufficient. Flag refund.
    update public.orders
       set status = 'failed',
           needs_refund = true,
           gateway_transaction_id = coalesce(p_transaction_id, gateway_transaction_id)
     where id = p_order;
    return 'oversold';
  end if;

  update public.orders
     set status = 'paid',
         gateway_transaction_id = coalesce(p_transaction_id, gateway_transaction_id)
   where id = p_order;

  return 'paid';
end;
$$;
