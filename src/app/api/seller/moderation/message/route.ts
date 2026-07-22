import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import type { Stream } from "@/lib/types";

const Body = z.object({
  streamId: z.string().uuid(),
  messageId: z.string().uuid(),
});

/**
 * Seller-side soft-delete of a chat message (Phase 4 / P4-C).
 *
 * Sets `chat_messages.deleted_at = now()` for `messageId` on the seller's own
 * stream. The table is intentionally never hard-deleted — the row stays for
 * the audit trail and for later dispute review.
 *
 * The UPDATE fires through the existing realtime subscription on the
 * `chat_messages` table; StreamView's `is(deleted_at, null)` filter (added in
 * P4-D) drops the softly-deleted message from view the moment the update
 * lands — for every viewer of that stream.
 *
 * Ownership is enforced by the `chat_messages_update_seller_soft_delete`
 * RLS policy (added in 0010_stream_mutes_bans.sql): only the stream's seller
 * can set `deleted_at`, and only to a non-null timestamp. We check ownership
 * up front anyway for a clear 403 in the common forged-body case.
 *
 * Note: an UPDATE (not a DELETE) — the with-check clause of the policy
 * requires `deleted_at is not null`, which an UPDATE setting it to now()
 * satisfies. A seller cannot un-delete (no policy path; if that becomes a
 * requirement, add a relaxed-policy UPDATE).
 */
export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify the stream exists and the caller owns it. We scope the UPDATE to
  // rows on this stream, but confirming ownership up front also lets us
  // distinguish 404 (stream/message missing) from 403 (not the owner).
  const { data: streamRow } = await supabase
    .from("streams")
    .select("*")
    .eq("id", parsed.streamId)
    .single();
  if (!streamRow) {
    return NextResponse.json({ error: "Stream not found" }, { status: 404 });
  }
  const stream = streamRow as Stream;
  if (stream.seller_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Soft-delete: set deleted_at = now(). Supabase/PostgREST uses
  // `headers: { 'Prefer': 'return=...' }` for returning rows; here we only
  // need to know whether the UPDATE hit anything. `count` tells us that.
  const { count, error } = await supabase
    .from("chat_messages")
    .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", parsed.messageId)
    .eq("stream_id", parsed.streamId)
    .is("deleted_at", null); // don't re-touch already-deleted rows
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!count) {
    // Either the message never existed, wasn't on this stream, or was already
    // deleted. From the seller's POV these all read as "already gone" — a 409
    // would force a refresh path the UI doesn't need; a 200 with no change is
    // idempotent and lets the optimistic UI stay consistent.
    return NextResponse.json({ ok: true, unchanged: true });
  }
  return NextResponse.json({ ok: true });
}
