-- =============================================================================
-- Live Shop — viewer-side moderation: block + report (Phase 2 / P2-E).
--
-- Two tables:
--   * blocks   — a viewer's personal block list. Drives chat filtering on the
--                viewer's own stream view (blocked users' messages don't render
--                for the blocker). NOT a global mute — the blocked user can
--                still post; they're just hidden from the blocker. Mirrors the
--                follows graph shape (composite PK, cascade on both FKs).
--   * reports  — a viewer-flagged incident for admin review. Carries the
--                reported user, optional message id, stream context, and a
--                free-text reason. Admins read via service role; reporters read
--                only their own.
--
-- Design notes:
--   * Composite PK (blocker_id, blocked_id) is the natural uniqueness key — a
--     duplicate block is a PK violation (23505), which the API maps to a
--     successful no-op (already blocked). No separate unique index needed.
--   * `on delete cascade` on both FKs: deleting a user removes their blocks in
--     both directions automatically.
--   * check (blocker_id <> blocked_id): backstop against self-block. The API
--     rejects it earlier; this guarantees it can't happen even via a raw write.
--   * reports carry a `reason` (free text, capped at the API layer) and an
--     optional `message_id` for "report this message" flows. `message_id` is
--     nullable because a report can target a user (not a specific message), e.g.
--     from the seller's profile card.
--   * NOT added to supabase_realtime: nothing subscribes to blocks/reports yet.
--     Block-list refresh happens via an explicit GET /api/block on stream
--     activation (the filter is computed in JS, not pushed via realtime).
--
-- Security: a client can only INSERT/DELETE rows where they are the blocker
-- (RLS). They can never block on behalf of another user, and the API always
-- uses user.id as blocker_id. SELECT is owner-only (a user sees only their own
-- block list) — unlike follows, blocks are private.
--
-- Idempotent + safe to re-run. Mirrors the style of 0001-0007.
-- =============================================================================

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

-- The PK covers blocker-side lookups (who have I blocked?); this index covers
-- the inverse (who blocked X?) for any future admin/impact views.
create index if not exists blocks_blocked_id_idx
  on public.blocks(blocked_id);

create table if not exists public.reports (
  id uuid not null default gen_random_uuid() primary key,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_id uuid not null references public.profiles(id) on delete cascade,
  stream_id uuid references public.streams(id) on delete set null,
  reason text not null,
  message_id uuid references public.chat_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  check (reporter_id <> reported_id)
);

-- Index the reporter's own-history lookup (their submitted reports) and the
-- reported-user lookup (admin "reports about X" view).
create index if not exists reports_reporter_id_idx
  on public.reports(reporter_id);
create index if not exists reports_reported_id_idx
  on public.reports(reported_id);

-- ─── Enable RLS ──────────────────────────────────────────────────────────────
alter table public.blocks enable row level security;
alter table public.reports enable row level security;

-- ─── blocks policies ─────────────────────────────────────────────────────────
-- A user sees only their OWN block list (blocks are private, unlike follows).
drop policy if exists "blocks_select_own" on public.blocks;
create policy "blocks_select_own" on public.blocks
  for select using (auth.uid() = blocker_id);

-- A user may only create blocks where THEY are the blocker.
drop policy if exists "blocks_insert_own" on public.blocks;
create policy "blocks_insert_own" on public.blocks
  for insert with check (auth.uid() = blocker_id);

-- A user may only unblock (delete) rows where THEY are the blocker.
drop policy if exists "blocks_delete_own" on public.blocks;
create policy "blocks_delete_own" on public.blocks
  for delete using (auth.uid() = blocker_id);

-- (No UPDATE policy → RLS denies by default. Blocks are create/delete only.)

-- ─── reports policies ───────────────────────────────────────────────────────
-- A reporter can see their own submitted reports (status of reports they filed).
-- Admins read all reports via the service-role client, which bypasses RLS.
drop policy if exists "reports_select_own" on public.reports;
create policy "reports_select_own" on public.reports
  for select using (auth.uid() = reporter_id);

-- A user may only submit reports where THEY are the reporter.
drop policy if exists "reports_insert_own" on public.reports;
create policy "reports_insert_own" on public.reports
  for insert with check (auth.uid() = reporter_id);

-- (No UPDATE / DELETE policy → RLS denies by default. Reports are immutable
--  once submitted; only an admin (service role) can transition their state.)
