-- =============================================================================
-- Live Shop — Khalti identifier mapping fix.
--
-- Corrects the payment identifier model end-to-end:
--   - Khalti purchase_order_id = persisted orders.id (not a pre-payment UUID)
--   - Khalti pidx              = orders.khalti_pidx (unique, bound at initiate)
--   - Khalti transaction_id    = orders.gateway_transaction_id (set by
--                                fulfill_order on success; null until then)
--
-- Database constraints:
--   1. The unique partial index on khalti_pidx already exists (0006) — IF NOT
--      EXISTS prevents recreation.
--   2. Add a unique partial index on gateway_transaction_id for Khalti orders
--      so no two orders can share the same real Khalti transaction_id. NULLs
--      are excluded (pending orders have null gateway_transaction_id).
--   3. Add terminal lifecycle states for cancelled/expired orders.
--
-- Safe to run multiple times (idempotent — uses IF NOT EXISTS).
-- =============================================================================

-- ── 1. Ensure Khalti pidx uniqueness (should already exist from 0006) ────
create unique index if not exists orders_khalti_pidx_key
  on public.orders (khalti_pidx)
  where khalti_pidx is not null;

-- ── 2. Ensure Khalti transaction ID uniqueness ───────────────────────────
-- Pending Khalti orders have NULL gateway_transaction_id; only completed/
-- reconciled orders receive the real Khalti transaction_id via fulfill_order.
create unique index if not exists orders_khalti_txn_id_key
  on public.orders (gateway_transaction_id)
  where payment_gateway = 'khalti'
    and gateway_transaction_id is not null;

-- ── 3. Add terminal order lifecycle states ──────────────────────────────
alter type public.order_status add value if not exists 'cancelled';
alter type public.order_status add value if not exists 'expired';
