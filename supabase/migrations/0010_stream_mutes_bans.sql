-- =============================================================================
-- Live Shop — seller-side stream moderation (Phase 4 / P4-A).
--
-- Two enforceable moderation tables + a soft-delete column on chat_messages:
--   * stream_mutes — seller mutes a user for THEIR stream. Drives a live filter
--     on every viewer's StreamView: muted users' chat messages stop rendering
--     for ALL viewers of that stream (not just the seller). Orthogonal to the
--     Phase-2 viewer-side personal `blocks` list — both filters apply.
--   * stream_bans  — seller bans a user from THEIR stream. The token-issuance
--     route does an indexed lookup against this table and refuses (403) if the
--     user is banned, closing the reconnect-timing gap when a ban is issued
--     mid-stream. The ban route inserts here BEFORE calling LiveKit's
--     removeParticipant, so a racing reconnect is already refused by the time
--     the kick lands.
--   * chat_messages.deleted_at — soft-delete for seller message removal.
--     Preserves the audit trail; reads + realtime filter on `is(deleted_at, null)`.
--
-- Audit trail: per-action tables ARE the trail (stream_bans.banned_by +
-- reason + created_at, stream_mutes.muted_by + created_at). No separate
-- audit_log table exists in the codebase, so we follow the same pattern as
-- `reports` (which is the trail for viewer-side flags).
--
-- RLS model: the stream's seller (streams.seller_id) owns all mute/ban rows
-- for that stream — only they can INSERT/DELETE. Anyone can SELECT (viewers'
-- clients need to read the mute list to filter; the ban check is server-side at
-- token issuance). This mirrors `blocks` (owner-scoped writes, open reads for
-- filtering) and `stream_stats` (open SELECT).
--
-- Idempotent + safe to re-run. Mirrors the style of 0001-0009.
-- =============================================================================

-- ─── chat_messages: soft-delete column ───────────────────────────────────────
-- Null = visible. Non-null = seller removed it; filtered out of reads + realtime
-- by `is(deleted_at, null)`. We do NOT hard-delete: the message stays for audit
-- and for any later dispute review.
alter table public.chat_messages
  add column if not exists deleted_at timestamptz;

-- Index the visible-message lookup (the common read path filters on this).
create index if not exists chat_messages_deleted_at_idx
  on public.chat_messages(deleted_at);

-- ─── stream_mutes ────────────────────────────────────────────────────────────
create table if not exists public.stream_mutes (
  stream_id  uuid not null references public.streams(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  muted_by   uuid not null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (stream_id, user_id),
  check (user_id <> muted_by)  -- backstop against self-mute
);

-- The PK covers the seller's "who have I muted on this stream?" lookup; this
-- index covers the inverse for any future "is user X muted anywhere?" view.
create index if not exists stream_mutes_user_id_idx
  on public.stream_mutes(user_id);

-- ─── stream_bans ─────────────────────────────────────────────────────────────
-- reason is a short seller note (free text, capped at the API layer). The table
-- IS the audit trail: banned_by + reason + created_at is queryable history.
create table if not exists public.stream_bans (
  stream_id  uuid not null references public.streams(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  banned_by  uuid not null references public.profiles(id) on delete set null,
  reason     text not null default '',
  created_at timestamptz not null default now(),
  primary key (stream_id, user_id),
  check (user_id <> banned_by)  -- backstop against self-ban
);

-- Hot path: the token-issuance route looks up "is this user banned on this
-- stream?" by (stream_id, user_id) — the PK serves that. This index covers the
-- inverse + the seller's "who have I banned?" list.
create index if not exists stream_bans_user_id_idx
  on public.stream_bans(user_id);

-- ─── Enable RLS on the new tables ────────────────────────────────────────────
alter table public.stream_mutes enable row level security;
alter table public.stream_bans  enable row level security;

-- ─── stream_mutes policies ──────────────────────────────────────────────────
-- Anyone can SELECT (viewers' clients read the mute list to filter chat).
-- Only the stream's seller can INSERT/DELETE mutes. The seller-ownership check
-- is expressed via an EXISTS subquery on streams (seller_id = auth.uid()).
drop policy if exists "stream_mutes_select_all" on public.stream_mutes;
create policy "stream_mutes_select_all" on public.stream_mutes
  for select using (true);

drop policy if exists "stream_mutes_insert_seller" on public.stream_mutes;
create policy "stream_mutes_insert_seller" on public.stream_mutes
  for insert with check (
    muted_by = auth.uid()
    and exists (
      select 1 from public.streams s
       where s.id = stream_mutes.stream_id
         and s.seller_id = auth.uid()
    )
  );

drop policy if exists "stream_mutes_delete_seller" on public.stream_mutes;
create policy "stream_mutes_delete_seller" on public.stream_mutes
  for delete using (
    exists (
      select 1 from public.streams s
       where s.id = stream_mutes.stream_id
         and s.seller_id = auth.uid()
    )
  );

-- ─── stream_bans policies ────────────────────────────────────────────────────
-- Anyone can SELECT (so the client could surface "you're banned" UX if desired;
-- the enforcement is server-side at token issuance regardless).
-- Only the stream's seller can INSERT/DELETE bans.
drop policy if exists "stream_bans_select_all" on public.stream_bans;
create policy "stream_bans_select_all" on public.stream_bans
  for select using (true);

drop policy if exists "stream_bans_insert_seller" on public.stream_bans;
create policy "stream_bans_insert_seller" on public.stream_bans
  for insert with check (
    banned_by = auth.uid()
    and exists (
      select 1 from public.streams s
       where s.id = stream_bans.stream_id
         and s.seller_id = auth.uid()
    )
  );

drop policy if exists "stream_bans_delete_seller" on public.stream_bans;
create policy "stream_bans_delete_seller" on public.stream_bans
  for delete using (
    exists (
      select 1 from public.streams s
       where s.id = stream_bans.stream_id
         and s.seller_id = auth.uid()
    )
  );

-- ─── chat_messages: seller can soft-delete on their own stream ───────────────
-- The existing chat_messages policies (from 0001) let a user insert their own
-- messages. We add an UPDATE policy scoped to the stream's seller so ONLY the
-- seller can set deleted_at (a regular chatter cannot delete others' messages).
-- The check clause forces deleted_at to a real timestamp on update (the seller
-- never needs to un-delete; if that becomes a requirement, add a separate
-- policy or relax the check).
drop policy if exists "chat_messages_update_seller_soft_delete" on public.chat_messages;
create policy "chat_messages_update_seller_soft_delete" on public.chat_messages
  for update using (
    exists (
      select 1 from public.streams s
       where s.id = chat_messages.stream_id
         and s.seller_id = auth.uid()
    )
  )
  with check (
    deleted_at is not null
    and exists (
      select 1 from public.streams s
       where s.id = chat_messages.stream_id
         and s.seller_id = auth.uid()
    )
  );

-- ─── Realtime ────────────────────────────────────────────────────────────────
-- stream_mutes: push INSERT/DELETE so every viewer's StreamView filter updates
-- live the moment a seller mutes/unmutes someone. Without this, a muted user's
-- messages would keep rendering for viewers until their next mute-list refetch.
do $$ begin
  alter publication supabase_realtime add table public.stream_mutes;
exception when duplicate_object then null; end $$;

-- chat_messages is already in supabase_realtime (the chat subscription depends
-- on it). The deleted_at UPDATE will fire through the existing subscription;
-- the client filters on `is(deleted_at, null)` in its SELECT + drops UPDATEs
-- that set deleted_at.

-- stream_bans is NOT added to realtime: nobody subscribes to it client-side
-- (the enforcement is server-side at token issuance, and a banned user's
-- client doesn't need a live update — they're already being kicked).
