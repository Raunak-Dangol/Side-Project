-- =============================================================================
-- Live Shop — atomic order fulfillment + Khalti pidx binding.
--
-- Addresses two payment-integrity audit findings:
--
-- H1 (pidx replay): the Khalti callback trusted the `pidx` from the redirect
-- query string and only checked the amount. An attacker who paid once could
-- reuse the same valid `pidx` to mark ANY new order of equal amount as `paid`,
-- receiving products for free. Fix: store the `pidx` returned by Khalti at
-- initiation on the order, and in the callback require lookup.pidx to match.
--
-- H2 (double stock decrement): the callbacks used a read-then-write sequence
-- (read status; if pending → decrement stock → write paid) with no row lock, so
-- two concurrent/duplicate callbacks both saw `pending` and both decremented
-- stock. Fix: a single SECURITY DEFINER RPC that locks the order row, checks
-- status, and decrements stock inside the same transaction — so exactly one
-- callback can ever move a given order to `paid` and consume one unit of stock.
--
-- No RLS change: orders still have no client INSERT/UPDATE policy (service role
-- only), and the new column inherits that. Idempotent + safe to re-run.
-- =============================================================================

-- pidx returned by Khalti at initiation. NULL for eSewa orders. Uniqueness is
-- enforced only for live (non-null) values so eSewa rows + historical Khalti
-- rows don't collide. A pidx may appear at most once across orders, which is
-- what blocks replay.
alter table public.orders
  add column if not exists khalti_pidx text;

-- One order per pidx (NULLs excluded, so the many eSewa/historical rows are OK).
do $$ begin
  create unique index orders_khalti_pidx_key
    on public.orders (khalti_pidx)
    where khalti_pidx is not null;
exception when duplicate_table then null; end $$;

-- =============================================================================
-- fulfill_order — the ONLY way an order transitions pending → paid.
--
-- Locks the order row (SELECT FOR UPDATE) so concurrent callbacks serialize.
-- If the order is already paid/failed it's a no-op (idempotent). Otherwise it
-- atomically decrements stock: success → paid; stock already 0 → failed +
-- needs_refund (money moved, manual refund required). The gateway transaction
-- id is recorded only on success/oversold so the buyer's reference is accurate.
--
-- SECURITY DEFINER so the service-role API callbacks can run it; the order row
-- lock + status check make it safe to call more than once.
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
  v_decremented public.products;
begin
  -- Lock the order row. A second callback blocks here until the first commits,
  -- then re-reads status and sees 'paid' → no-op. This is the H2 fix.
  select * into v_order
    from public.orders
   where id = p_order
   for update;

  if not found then
    return 'not_found';
  end if;

  -- Idempotency: don't double-process. Covers gateway retries / duplicates and
  -- any order a prior callback already finalized.
  if v_order.status in ('paid', 'failed') then
    return 'already_handled';
  end if;

  -- Bind the pidx if provided (H1): recorded once on the fulfilling call so the
  -- unique index rejects a replay against a different order later.
  if p_khalti_pidx is not null and v_order.khalti_pidx is null then
    update public.orders
       set khalti_pidx = p_khalti_pidx
     where id = p_order and khalti_pidx is null;
  end if;

  -- Atomic decrement: succeeds only while stock > 0. Done under the order lock,
  -- so for this order only one caller ever decrements.
  select * into v_decremented
    from public.products
   where id = v_order.product_id and stock > 0
   for update of public.products;
  if found then
    update public.products
       set stock = stock - 1
     where id = v_order.product_id
    returning * into v_decremented;
  else
    v_decremented := null;
  end if;

  if v_decremented is null then
    -- Oversold race: payment completed but the item is gone. Flag for refund.
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
