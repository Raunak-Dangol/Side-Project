-- =============================================================================
-- Live Shop — unified account model (Douyin-style seller upgrade).
--
-- There is NO seller signup path. Every account is created identically
-- (seller_status = 'none') and keeps browsing/following/chatting as a normal
-- user. Seller capability is an UPGRADE applied to an existing account after
-- they submit seller_applications and an operator approves it via SQL.
--
-- This makes profiles.seller_status the single source of truth for "can this
-- account act as a seller." The legacy profiles.role = 'seller' signal is
-- retired as a capability marker — backfilled into seller_status below — and
-- 'role' is retained only for the platform-admin distinction ('admin').
--
-- Idempotent + safe to re-run. Mirrors the style of 0001/0002.
-- =============================================================================

-- ─── profiles: seller capability columns ─────────────────────────────────────
-- seller_status is THE source of truth for seller capability.
--   'none'     — default; normal user, no seller tools
--   'pending'  — application submitted, awaiting operator review
--   'approved' — may create/edit products & streams, access seller routes
--   'rejected' — last application was rejected; may reapply (creates a new row)
alter table public.profiles
  add column if not exists seller_status text not null default 'none'
    check (seller_status in ('none', 'pending', 'approved', 'rejected'));

alter table public.profiles
  add column if not exists seller_applied_at timestamptz;

alter table public.profiles
  add column if not exists seller_reviewed_at timestamptz;

-- ─── Backfill BEFORE tightening product/stream RLS ───────────────────────────
-- Migrate the legacy role-based capability into seller_status so nobody is
-- locked out the moment RLS starts requiring seller_status = 'approved'.
-- Existing 'seller' accounts become 'approved'; everyone else stays 'none'
-- (the column default already set them). Idempotent — only touches rows still
-- on the old signal.
update public.profiles
   set seller_status = 'approved',
       seller_reviewed_at = coalesce(seller_reviewed_at, now())
 where seller_status = 'none'
   and role = 'seller';

-- ─── seller_applications ─────────────────────────────────────────────────────
-- One row per submission. Reapplying after rejection creates a NEW row; the
-- unique index below only blocks duplicate 'pending' rows, so a rejected
-- history never blocks reapplication.
create table if not exists public.seller_applications (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  business_name       text,
  contact_phone       text,
  -- Prototype only: free-text note or a URL to an ID photo the user uploaded
  -- elsewhere. No real KYC in this pass.
  id_verification_note text,
  status              text not null default 'pending'
                        check (status in ('pending', 'approved', 'rejected')),
  submitted_at        timestamptz not null default now(),
  reviewed_at         timestamptz,
  reviewer_note       text
);

create index if not exists seller_applications_user_id_idx
  on public.seller_applications(user_id);
create index if not exists seller_applications_status_submitted_idx
  on public.seller_applications(status, submitted_at);

-- At most one PENDING application per user. Allows any number of
-- 'approved'/'rejected' rows (history) — only live 'pending' is unique.
create unique index if not exists one_pending_application_per_user
  on public.seller_applications (user_id)
  where status = 'pending';

-- ─── Enable RLS on seller_applications ───────────────────────────────────────
alter table public.seller_applications enable row level security;

-- Users can read their own applications (any status — including rejected, so
-- the UI can show history / reapply affordances).
drop policy if exists "seller_applications_select_own" on public.seller_applications;
create policy "seller_applications_select_own" on public.seller_applications
  for select using (auth.uid() = user_id);

-- Users can submit (insert) their own application. The actual insert is done
-- through the submit_seller_application RPC (service role bypasses RLS), but
-- this policy also permits a direct client insert as a fallback.
drop policy if exists "seller_applications_insert_own" on public.seller_applications;
create policy "seller_applications_insert_own" on public.seller_applications
  for insert with check (auth.uid() = user_id);

-- Intentionally NO UPDATE policy. Approval / rejection happens ONLY via the
-- Supabase SQL editor using the service role — exactly like the existing
-- is_verified toggle in 0002. Do not add an admin UI or an UPDATE policy in
-- this pass (see "Manual approval" block at the bottom of this file).

-- ─── Gap-fill products RLS: require seller_status = 'approved' ───────────────
-- The existing ownership policies (auth.uid() = seller_id) only proved the row
-- belongs to the caller — they did NOT prove the caller is allowed to be a
-- seller at all. Under the old model any authenticated user could create
-- products/streams. We now add the capability check so only approved sellers
-- can write. SELECT stays open (anyone can browse).
drop policy if exists "products_insert_own" on public.products;
create policy "products_insert_own" on public.products
  for insert with check (
    auth.uid() = seller_id
    and exists (
      select 1 from public.profiles
       where id = auth.uid()
         and seller_status = 'approved'
    )
  );

drop policy if exists "products_update_own" on public.products;
create policy "products_update_own" on public.products
  for update using (
    auth.uid() = seller_id
    and exists (
      select 1 from public.profiles
       where id = auth.uid()
         and seller_status = 'approved'
    )
  ) with check (
    auth.uid() = seller_id
    and exists (
      select 1 from public.profiles
       where id = auth.uid()
         and seller_status = 'approved'
    )
  );

drop policy if exists "products_delete_own" on public.products;
create policy "products_delete_own" on public.products
  for delete using (
    auth.uid() = seller_id
    and exists (
      select 1 from public.profiles
       where id = auth.uid()
         and seller_status = 'approved'
    )
  );

-- ─── Gap-fill streams RLS: require seller_status = 'approved' ────────────────
drop policy if exists "streams_insert_own" on public.streams;
create policy "streams_insert_own" on public.streams
  for insert with check (
    auth.uid() = seller_id
    and exists (
      select 1 from public.profiles
       where id = auth.uid()
         and seller_status = 'approved'
    )
  );

drop policy if exists "streams_update_own" on public.streams;
create policy "streams_update_own" on public.streams
  for update using (
    auth.uid() = seller_id
    and exists (
      select 1 from public.profiles
       where id = auth.uid()
         and seller_status = 'approved'
    )
  ) with check (
    auth.uid() = seller_id
    and exists (
      select 1 from public.profiles
       where id = auth.uid()
         and seller_status = 'approved'
    )
  );

drop policy if exists "streams_delete_own" on public.streams;
create policy "streams_delete_own" on public.streams
  for delete using (
    auth.uid() = seller_id
    and exists (
      select 1 from public.profiles
       where id = auth.uid()
         and seller_status = 'approved'
    )
  );

-- =============================================================================
-- submit_seller_application — atomic application + profile transition.
--
-- SECURITY DEFINER so the API route can call it without exposing a raw client
-- path to update profiles.seller_status. search_path locked to public.
--
-- Inserts a 'pending' seller_applications row AND flips the caller's profile to
-- seller_status = 'pending' in ONE transaction, so the two writes can never
-- partially fail. The unique-pending index surfaces a 23505 (unique_violation)
-- if a 'pending' application already exists for this user; the API route maps
-- that to a 409. The p_user argument is validated against auth.uid() so a
-- caller cannot submit on someone else's behalf.
-- =============================================================================
create or replace function public.submit_seller_application(
  p_user      uuid,
  p_business  text,
  p_phone     text,
  p_note      text
)
returns public.seller_applications
language plpgsql
security definer
set search_path = public
as $$
declare
  app_row public.seller_applications;
  current_status text;
begin
  -- Guard against impersonation: caller must match the subject.
  if auth.uid() is distinct from p_user then
    raise exception 'cannot submit application for another user' using errcode = '42501';
  end if;

  -- Refuse if already approved — no point re-applying.
  select seller_status into current_status
    from public.profiles where id = p_user;
  if current_status = 'approved' then
    raise exception 'already an approved seller' using errcode = 'P0001';
  end if;

  -- Insert the application row. If a 'pending' row already exists, the
  -- one_pending_application_per_user index raises unique_violation (23505),
  -- which the API route translates into a 409 "under review".
  insert into public.seller_applications (user_id, business_name, contact_phone, id_verification_note)
  values (p_user, p_business, p_phone, p_note)
  returning * into app_row;

  -- Flip the profile to pending. Same transaction → atomic with the insert.
  update public.profiles
     set seller_status = 'pending',
         seller_applied_at = now()
   where id = p_user;

  return app_row;
end;
$$;

-- =============================================================================
-- NOTE on handle_new_user (defined in 0001): it still inserts role = 'buyer'.
-- New accounts get seller_status = 'none' via the column default above — no
-- trigger change needed. role is retained ONLY for platform-admin ('admin');
-- 'seller' as a role value is now dormant (retained in the enum to avoid a
-- destructive type change, but no longer read as a capability signal).
-- =============================================================================

-- =============================================================================
-- MANUAL APPROVAL / REJECTION (SQL-only, no admin UI in this pass — mirrors the
-- existing is_verified toggle pattern from 0002).
--
-- Run these in the Supabase SQL editor with the service role.
--
-- -- List pending applicants:
-- select p.id, p.display_name, sa.business_name, sa.contact_phone, sa.submitted_at
-- from public.seller_applications sa
-- join public.profiles p on p.id = sa.user_id
-- where sa.status = 'pending'
-- order by sa.submitted_at asc;
--
-- -- Approve a user:
-- update public.profiles
--   set seller_status = 'approved', seller_reviewed_at = now()
--   where id = '<user-uuid-here>';
--
-- update public.seller_applications
--   set status = 'approved', reviewed_at = now()
--   where user_id = '<user-uuid-here>' and status = 'pending';
--
-- -- Or reject (user may reapply — that creates a new 'pending' row):
-- update public.profiles
--   set seller_status = 'rejected', seller_reviewed_at = now()
--   where id = '<user-uuid-here>';
--
-- update public.seller_applications
--   set status = 'rejected', reviewed_at = now(), reviewer_note = '<reason>'
--   where user_id = '<user-uuid-here>' and status = 'pending';
-- =============================================================================
