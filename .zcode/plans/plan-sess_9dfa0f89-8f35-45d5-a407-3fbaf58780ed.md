# Unified Account Model — Seller Upgrade Flow

Implementing the Douyin-style "seller is an upgrade, not a signup path" model. One source of truth for seller capability: `profiles.seller_status`. The old `profiles.role = 'seller'` is retired as a capability signal.

## Decisions (confirmed)
- **Entry point:** Navbar "Become a seller" link (TODO to fold into a profile menu later).
- **Backfill:** Existing `role='seller'` → `seller_status='approved'`; everyone else → `'none'`. No lockout.

## ★ Critical guard specification (confirmed)
**Every "pending application" check — in the step 4 page state, the step 5 API guard, AND the `submit_seller_application` RPC — filters on `status = 'pending'` specifically. Never "most recent application by submitted_at" or "any application exists."** A rejected history must NOT block reapplication. The unique index `... where status = 'pending'` already enforces this at the DB layer; the app-layer lookups will mirror that exact predicate. Concretely:
- Page state lookup: `select * from seller_applications where user_id = $1 and status = 'pending' limit 1` → if a row comes back, show pending state; else fall through to form (regardless of any prior rejected rows).
- API guard: same predicate → 409 only when a pending row exists.
- Reapply after rejection: a new INSERT with `status='pending'` is allowed because the index only blocks duplicate pending rows.

## Step 1 — Migration `supabase/migrations/0003_seller_upgrade_model.sql`
Idempotent, full RLS:
- Add `seller_status` (text, default `'none'`, check), `seller_applied_at`, `seller_reviewed_at` to `profiles`.
- **Backfill first:** `update profiles set seller_status = 'approved', seller_reviewed_at = now() where role = 'seller'`.
- `create table seller_applications (...)`, RLS enabled. SELECT/INSERT own rows; **no UPDATE policy** (SQL-only approval, matching `is_verified`).
- `create unique index one_pending_application_per_user on seller_applications(user_id) where status = 'pending'`.
- **Gap-fill products/streams RLS** (current policies check ownership only, not capability): rewrite insert/update/delete policies to add `and exists (select 1 from profiles where id = auth.uid() and seller_status = 'approved')`. SELECT unchanged.
- **New RPC `submit_seller_application(p_user uuid, p_business text, p_phone text, p_note text)`** — SECURITY DEFINER, one transaction: insert `seller_applications` row (status pending) + update `profiles` (`seller_status='pending'`, `seller_applied_at=now()`). Raises a check on the unique-pending index so the API can map a dup to a 409.
- Comment block documenting the manual SQL approve/reject process.
- `handle_new_user()` trigger: add comment noting new accounts are `'none'` by default via column default; keep `role='buyer'` insert (role retained for platform-admin).

## Step 2 — Type sync: `src/lib/types.ts` + `src/lib/db-types.ts`
- `UserRole = "buyer" | "admin"` (drop `"seller"`). Add `SellerStatus`.
- `Profile`: add `seller_status`, `seller_applied_at`, `seller_reviewed_at`.
- Add `SellerApplication` interface + DB table types + the new RPC in `Functions`.
- Update `profiles` role unions and `Enums.user_role`.

## Step 3 — `/login` cleanup
No account-type selector exists (verified). Footer hint → point at `/seller/apply`. Auth callback untouched.

## Step 4 — `src/app/seller/apply/page.tsx`
Server component. Auth-gate. Fetch profile + pending application (★ `status='pending'` predicate). Branch:
- `seller_status === 'approved'` → `redirect("/seller/dashboard")`.
- pending row exists → pending banner.
- else → form (incl. reapply-after-rejected path). `// TODO (post-prototype): real ID/business-license verification + deposit collection`.

## Step 5 — `POST /api/seller/apply/route.ts`
Zod body (businessName, contactPhone, idVerificationNote), require auth. Guards (★ pending-specific): `seller_status === 'approved'` → 409; pending row exists → 409 "under review". Then call `submit_seller_application` RPC (atomic). Return application row.

## Step 6 — Gate `/seller/dashboard` + `/seller/orders`
Server-side: if `seller_status !== 'approved'` → `redirect("/seller/apply")`. `/seller/apply` exempt.

## Step 7 — Retire old role UI
- `SellerDashboard.tsx`: delete self-grant "Become a seller" block.
- `Navbar.tsx`: `seller_status === 'approved'` for seller links; add "Become a seller" link for non-approved signed-in users; drop role badge.
- `login/page.tsx`: footer hint → `/seller/apply`.
- `StreamView.tsx:357`: simplify to `Boolean(seller?.is_verified)`.
- **Untouched** (per prompt): `livekit-token` `"seller"|"viewer"` participant role, `StreamRoom`, `VideoStage`, middleware, checkout/LiveKit/chat/reactions/ticker/rank.

## Step 8 — Manual test (you run this)
Fresh account → browse/chat at `seller_status='none'` → apply → `'pending'` + seller routes redirect to `/seller/apply` → SQL approval → `/seller/dashboard` without re-auth.

Building now in order; diff surfaced per step.