-- =============================================================================
-- Live Shop — stream redesign addendum.
-- New presentation-layer backing: promo banners, verified flag, viewer-count
-- stats (for the hourly rank badge), and reactions (heart/gift tap counters).
--
-- Idempotent + safe to re-run. RLS is ENABLED on every new table. All policies
-- written out in full (no TODOs), mirroring the style of 0001_init.sql.
--
-- Write model: clients can only ever SELECT these tables. All mutations go
-- through server API routes using the service role (stream_stats, promo) or the
-- SECURITY DEFINER increment_reaction RPC (reactions) — never raw client writes.
-- =============================================================================

-- ─── Columns on existing tables ──────────────────────────────────────────────
alter table public.streams
  add column if not exists promo_banner_text text;

alter table public.streams
  add column if not exists promo_banner_link text;

-- Verified-seller flag. There is NO verification workflow yet — this is flipped
-- manually by an admin via the service role (see the doc comment below). A user
-- can already UPDATE their own profile row via RLS (profiles_update_own), but
-- self-granting is pointless because the badge is meant to be authoritative.
alter table public.profiles
  add column if not exists is_verified boolean not null default false;

-- ─── stream_stats: per-stream viewer count snapshot for rank computation ─────
-- viewer_count is NOT persisted live on the streams row; it's tracked via a
-- Realtime presence channel at runtime. Each client periodically POSTs the
-- current presence-derived count here, and RankBadge ranks streams off it.
-- It only needs to be roughly correct for a prototype.
create table if not exists public.stream_stats (
  stream_id    uuid primary key references public.streams(id) on delete cascade,
  viewer_count integer not null default 0 check (viewer_count >= 0),
  updated_at   timestamptz not null default now()
);

-- ─── reactions: one row per stream per reaction kind (heart | gift) ──────────
-- The (stream_id, kind) unique constraint means the increment_reaction RPC can
-- do an INSERT ... ON CONFLICT DO UPDATE to atomically add to the running total,
-- instead of one row per tap-batch.
create table if not exists public.reactions (
  id         uuid primary key default gen_random_uuid(),
  stream_id  uuid not null references public.streams(id) on delete cascade,
  kind       text not null check (kind in ('heart','gift')),
  count      integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  unique (stream_id, kind)
);
create index if not exists reactions_stream_id_idx on public.reactions(stream_id);

-- ─── Enable RLS on new tables ────────────────────────────────────────────────
alter table public.stream_stats enable row level security;
alter table public.reactions   enable row level security;

-- ─── stream_stats policies ───────────────────────────────────────────────────
-- Anyone can read (RankBadge is rendered for all viewers). NO client
-- INSERT/UPDATE/DELETE — a malicious client could otherwise fake a huge viewer
-- count to win the rank badge. Writes happen only via the server (service role)
-- in POST /api/streams/[id]/stats.
drop policy if exists "stream_stats_select_all" on public.stream_stats;
create policy "stream_stats_select_all" on public.stream_stats
  for select using (true);

-- ─── reactions policies ──────────────────────────────────────────────────────
-- Anyone can read (the live counter is broadcast to all viewers). NO direct
-- client INSERT/UPDATE/DELETE — all writes go through the increment_reaction
-- RPC, which is only callable from the server API route
-- POST /api/streams/[id]/react (where rate-limiting + amount capping live).
drop policy if exists "reactions_select_all" on public.reactions;
create policy "reactions_select_all" on public.reactions
  for select using (true);

-- ─── Realtime ────────────────────────────────────────────────────────────────
-- Broadcast reaction-total updates to all viewers; stream_stats changes feed
-- RankBadge if it chooses to listen instead of polling.
do $$ begin
  alter publication supabase_realtime add table public.stream_stats;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.reactions;
exception when duplicate_object then null; end $$;

-- =============================================================================
-- Atomic reaction increment. SECURITY DEFINER so the service-role API route can
-- run it without an RLS policy allowing arbitrary client writes. search_path is
-- locked to public to prevent search_path injection.
-- =============================================================================
create or replace function public.increment_reaction(
  p_stream_id uuid,
  p_kind      text,
  p_amount    integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount <= 0 then
    return;  -- no-op on zero/negative; the API route also caps the upper bound
  end if;
  insert into public.reactions (stream_id, kind, count)
  values (p_stream_id, p_kind, p_amount)
  on conflict (stream_id, kind)
  do update set count      = public.reactions.count + excluded.count,
                updated_at = now();
end;
$$;

-- =============================================================================
-- Admin-only manual toggle for profile verification (no workflow built yet).
--
-- There is intentionally NO client API for this. An admin flips it via the SQL
-- editor using the service role, e.g.:
--
--   update public.profiles set is_verified = true where id = '<user-uuid>';
--
-- The profiles_update_own RLS policy would also let a user self-toggle, but the
-- badge is only meaningful when granted by an operator, so self-granting has no
-- real effect on trust.
-- =============================================================================
