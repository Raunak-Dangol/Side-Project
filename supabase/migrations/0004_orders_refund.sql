-- 0004: structured refund tracking on orders.
--
-- When a payment SUCCEEDS but the item is oversold (stock hit zero in a race),
-- money has been taken but there is no item to ship. Previously this was only
-- logged to the server console ("needs manual refund"). These columns make the
-- state queryable so a seller can see a "Needs refund" queue and resolve it.
--
-- No RLS change is needed: sellers already read orders on their own products
-- via the existing `orders_select_buyer_or_seller` policy, and buyers read
-- their own orders.

alter table public.orders
  add column if not exists needs_refund boolean not null default false,
  add column if not exists refund_status text;

-- Keep the backlog trustworthy: any order that already failed should not be
-- surfaced as needing a refund.
update public.orders
  set needs_refund = false
  where status <> 'paid';
