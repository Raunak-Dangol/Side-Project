import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import type { Stream } from "@/lib/types";

/**
 * Seller-side mute/unmute (Phase 4 / P4-C).
 *
 *   POST   /api/seller/moderation   { streamId, userId }   → insert stream_mutes
 *   DELETE /api/seller/moderation   ?streamId=&userId=      → delete stream_mutes
 *
 * Seller-only. The mute is enforced live on every viewer's StreamView: a
 * realtime subscription on `stream_mutes` (added to supabase_realtime in
 * 0010_stream_mutes_bans.sql) updates the filter the instant a mute lands.
 *
 * The RLS `stream_mutes_insert_seller` / `_delete_seller` policies express
 * the same ownership check (`streams.seller_id = auth.uid()`), so even a
 * forged body that named another stream's id would be refused by Postgres.
 * We still check ownership up front to return a clear 403 instead of an RLS
 * error and to short-circuit before the round trip.
 */
async function loadOwnedStream(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  streamId: string,
  userId: string,
): Promise<Stream | { status: number; body: { error: string } }> {
  const user = await getAuthenticatedUser(supabase);
  if (!user) return { status: 401, body: { error: "Unauthorized" } };
  const { data: streamRow } = await supabase
    .from("streams")
    .select("*")
    .eq("id", streamId)
    .single();
  if (!streamRow) return { status: 404, body: { error: "Stream not found" } };
  const stream = streamRow as Stream;
  if (stream.seller_id !== user.id) {
    return { status: 403, body: { error: "Forbidden" } };
  }
  // A seller can't mute themselves (also backed by the table CHECK constraint).
  if (stream.seller_id === userId) {
    return { status: 400, body: { error: "Cannot mute yourself" } };
  }
  return stream;
}

const PostBody = z.object({
  streamId: z.string().uuid(),
  userId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof PostBody>;
  try {
    parsed = PostBody.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const owned = await loadOwnedStream(supabase, parsed.streamId, parsed.userId);
  if ("body" in owned) {
    return NextResponse.json(owned.body, { status: owned.status });
  }
  const me = (await getAuthenticatedUser(supabase))!;

  // Upsert: insert with `onConflict` so a duplicate mute is idempotent (returns
  // 200, not a PK violation). The PK (stream_id, user_id) is the conflict key.
  const { error } = await supabase
    .from("stream_mutes")
    .upsert({
      stream_id: parsed.streamId,
      user_id: parsed.userId,
      muted_by: me.id,
    })
    .eq("stream_id", parsed.streamId)
    .eq("user_id", parsed.userId);
  // The `.eq()` filters above are redundant for an upsert (the row's keys are
  // what they are), but they scope the operation so supabase-js won't warn
  // about an unfiltered upsert in strict mode.
  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);
  const streamId = url.searchParams.get("streamId");
  const userId = url.searchParams.get("userId");
  const parsed = PostBody.safeParse({ streamId, userId });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const owned = await loadOwnedStream(supabase, parsed.data.streamId, parsed.data.userId);
  if ("body" in owned) {
    return NextResponse.json(owned.body, { status: owned.status });
  }

  const { error } = await supabase
    .from("stream_mutes")
    .delete()
    .eq("stream_id", parsed.data.streamId)
    .eq("user_id", parsed.data.userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
