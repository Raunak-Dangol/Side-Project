-- =============================================================================
-- Live Shop — user follows (follower / followee relationships).
--
-- Public follow graph: any user may follow any other user. Follows are visible
-- to everyone (like Twitter/TikTok) so follower/following counts and lists can
-- be rendered on any profile page without per-row RLS negotiation.
--
-- Design notes:
--   * Composite PK (follower_id, followee_id) is the natural uniqueness key —
--     a duplicate follow is a PK violation (23505), which the API maps to a
--     successful no-op (already following). No separate unique index needed.
--   * `on delete cascade` on both FKs: deleting a user removes their follows in
--     both directions automatically.
--   * check (follower_id <> followee_id): backstop against self-follow. The API
--     rejects it earlier (422); this guarantees it can't happen even via a raw
--     service-role write.
--   * Counts are computed at read time (count(*)), NOT stored. Simpler, can't
--     drift out of sync, and fine for prototype volume. If counts ever become a
--     hot path, add a trigger-maintained counter later.
--   * NOT added to supabase_realtime: nothing subscribes to follows yet. Add it
--     back only when a live-update use case is actually built.
--
-- Security: clients can only INSERT/DELETE rows where they are the follower
-- (RLS). They can never follow on behalf of another user, and the API always
-- uses user.id as follower_id. SELECT is public.
--
-- Idempotent + safe to re-run. Mirrors the style of 0001-0006.
-- =============================================================================

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followee_id uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);

-- The PK covers follower-side lookups (who does X follow?); this index covers
-- the follower-list query (who follows X?).
create index if not exists follows_followee_id_idx
  on public.follows(followee_id);

-- ─── Enable RLS ──────────────────────────────────────────────────────────────
alter table public.follows enable row level security;

-- ─── Policies ────────────────────────────────────────────────────────────────
-- Public reads: follower/following counts and lists must work on any profile.
drop policy if exists "follows_select_all" on public.follows;
create policy "follows_select_all" on public.follows
  for select using (true);

-- A user may only create follows where THEY are the follower.
drop policy if exists "follows_insert_own" on public.follows;
create policy "follows_insert_own" on public.follows
  for insert with check (auth.uid() = follower_id);

-- A user may only unfollow (delete) rows where THEY are the follower.
drop policy if exists "follows_delete_own" on public.follows;
create policy "follows_delete_own" on public.follows
  for delete using (auth.uid() = follower_id);

-- (No UPDATE policy → RLS denies by default. Follows are create/delete only.)
