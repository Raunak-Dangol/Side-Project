-- =============================================================================
-- Live Shop — initial schema, RLS policies, and profile-creation trigger
-- Run this in the Supabase SQL editor (or `supabase db push`).
-- All tables have RLS ENABLED. Policies are written out in full — no TODOs.
-- =============================================================================

-- ─── Enums ───────────────────────────────────────────────────────────────────
do $$ begin
  create type user_role as enum ('buyer', 'seller', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type stream_status as enum ('scheduled', 'live', 'ended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_gateway as enum ('khalti', 'esewa');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum ('pending', 'paid', 'failed');
exception when duplicate_object then null; end $$;

-- ─── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role         user_role not null default 'buyer',
  created_at   timestamptz not null default now()
);

create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  seller_id   uuid not null references public.profiles(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  price_cents integer not null check (price_cents > 0),
  stock       integer not null default 0 check (stock >= 0),
  image_url   text,
  created_at  timestamptz not null default now()
);
create index if not exists products_seller_id_idx on public.products(seller_id);

create table if not exists public.streams (
  id               uuid primary key default gen_random_uuid(),
  seller_id        uuid not null references public.profiles(id) on delete cascade,
  title            text not null check (length(trim(title)) > 0),
  status           stream_status not null default 'scheduled',
  livekit_room_name text not null,
  pinned_product_id uuid references public.products(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists streams_status_idx on public.streams(status);
create index if not exists streams_seller_id_idx on public.streams(seller_id);

create table if not exists public.orders (
  id                     uuid primary key default gen_random_uuid(),
  buyer_id               uuid not null references public.profiles(id) on delete cascade,
  product_id             uuid not null references public.products(id) on delete restrict,
  stream_id              uuid not null references public.streams(id) on delete cascade,
  payment_gateway        payment_gateway not null,
  gateway_transaction_id text,
  status                 order_status not null default 'pending',
  amount_cents           integer not null check (amount_cents >= 0),
  created_at             timestamptz not null default now()
);
create index if not exists orders_buyer_id_idx on public.orders(buyer_id);
create index if not exists orders_product_id_idx on public.orders(product_id);
create index if not exists orders_status_idx on public.orders(status);

create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  stream_id  uuid not null references public.streams(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  message    text not null check (length(trim(message)) > 0 and length(message) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_stream_id_created_idx
  on public.chat_messages(stream_id, created_at);

-- ─── Enable RLS ───────────────────────────────────────────────────────────────
-- if you create any new tables later outside of migrations, those won't have RLS enabled by default — you'd need to add alter table ... enable row level security; and the corresponding policies yourself.
alter table public.profiles       enable row level security;
alter table public.products       enable row level security;
alter table public.streams        enable row level security;
alter table public.orders         enable row level security;
alter table public.chat_messages  enable row level security;

-- ─── Helper: is service role (server-side privileged context) ─────────────────
-- The PostgREST service role bypasses RLS, but we expose this for clarity in
-- policies that conceptually only apply to client (anon) connections.
create or replace function public.is_service_role()
returns boolean
language sql stable
as $$
  select coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role';
$$;

-- ─── profiles policies ───────────────────────────────────────────────────────
-- Everyone can read profiles (for display names). Users can update only their own.
drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all" on public.profiles
  for select using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

-- ─── products policies ───────────────────────────────────────────────────────
-- Anyone can SELECT; only the owning seller can INSERT/UPDATE/DELETE.
drop policy if exists "products_select_all" on public.products;
create policy "products_select_all" on public.products
  for select using (true);

drop policy if exists "products_insert_own" on public.products;
create policy "products_insert_own" on public.products
  for insert with check (auth.uid() = seller_id);

drop policy if exists "products_update_own" on public.products;
create policy "products_update_own" on public.products
  for update using (auth.uid() = seller_id) with check (auth.uid() = seller_id);

drop policy if exists "products_delete_own" on public.products;
create policy "products_delete_own" on public.products
  for delete using (auth.uid() = seller_id);

-- ─── streams policies ────────────────────────────────────────────────────────
-- Anyone can SELECT; only the owning seller can INSERT/UPDATE their own streams.
drop policy if exists "streams_select_all" on public.streams;
create policy "streams_select_all" on public.streams
  for select using (true);

drop policy if exists "streams_insert_own" on public.streams;
create policy "streams_insert_own" on public.streams
  for insert with check (auth.uid() = seller_id);

drop policy if exists "streams_update_own" on public.streams;
create policy "streams_update_own" on public.streams
  for update using (auth.uid() = seller_id) with check (auth.uid() = seller_id);

drop policy if exists "streams_delete_own" on public.streams;
create policy "streams_delete_own" on public.streams
  for delete using (auth.uid() = seller_id);

-- ─── orders policies ─────────────────────────────────────────────────────────
-- A user may read their own orders (as buyer) OR orders on their own products
-- (as seller). INSERT/UPDATE only via service role (server) — no client policy.
drop policy if exists "orders_select_buyer_or_seller" on public.orders;
create policy "orders_select_buyer_or_seller" on public.orders
  for select using (
    auth.uid() = buyer_id
    or exists (
      select 1 from public.products p
      where p.id = orders.product_id and p.seller_id = auth.uid()
    )
  );

-- No INSERT/UPDATE policies for anon/authenticated clients → those operations
-- are only allowed via the service role key (server API routes). This is by
-- design: the trusted server creates orders and transitions status.

-- ─── chat_messages policies ──────────────────────────────────────────────────
-- Anyone can SELECT messages for a stream; any authenticated user can INSERT
-- their own messages; no one can UPDATE/DELETE others' messages.
drop policy if exists "chat_select_all" on public.chat_messages;
create policy "chat_select_all" on public.chat_messages
  for select using (true);

drop policy if exists "chat_insert_own" on public.chat_messages;
create policy "chat_insert_own" on public.chat_messages
  for insert with check (auth.uid() = user_id);

-- (No update/delete policies → RLS denies by default.)

-- ─── Realtime ────────────────────────────────────────────────────────────────
-- Enable Realtime on streams (pinned product) and chat_messages.
do $$ begin
  alter publication supabase_realtime add table public.streams;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.chat_messages;
exception when duplicate_object then null; end $$;

-- =============================================================================
-- Auto-create a profile row on signup.
-- SECURITY DEFINER + search_path lock-down so it can run as the owner.
-- =============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name',
             new.raw_user_meta_data->>'name',
             split_part(new.email, '@', 1)),
    'buyer'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- Helper RPC used by the seller to pin a product on their own stream.
-- Wrapped as SECURITY DEFINER so it bypasses the "orders can't be updated by
-- clients" constraint via a controlled entry point (we still keep RLS strict on
-- orders; this only touches streams + is guarded by seller ownership).
-- Actually: streams are already updatable by the owning seller via RLS, so the
-- client can update pinned_product_id directly. This RPC is provided as a
-- convenience for the server-side pin API route.
-- =============================================================================
create or replace function public.set_pinned_product(p_stream uuid, p_product uuid)
returns public.streams
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.streams;
begin
  update public.streams
     set pinned_product_id = p_product
   where id = p_stream and seller_id = auth.uid()
  returning * into row;
  return row;
end;
$$;

-- =============================================================================
-- Atomic stock decrement. Returns the updated product row, or NULL if stock was
-- already 0 (oversold race). SECURITY DEFINER so the service-role caller can
-- run it without an RLS policy allowing arbitrary product updates.
-- =============================================================================
create or replace function public.decrement_stock(p_product_id uuid)
returns public.products
language sql
security definer
set search_path = public
as $$
  update public.products
     set stock = stock - 1
   where id = p_product_id and stock > 0
  returning *;
$$;
