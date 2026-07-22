import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { banUser } from "@/lib/livekit";
import type { Stream } from "@/lib/types";

const Body = z.object({
  streamId: z.string().uuid(),
  userId: z.string().uuid(),
  reason: z.string().trim().max(280).optional(),
});

/**
 * Seller-side ban from a stream (Phase 4 / P4-C).
 *
 * TWO effects, in this strict order:
 *   (a) INSERT into `stream_bans` — the authoritative gate. The token-
 *       issuance route does an indexed lookup against this table and
 *       returns 403 for a banned user, so any reconnect is refused.
 *   (b) `RoomServiceClient.removeParticipant` — kick the user from the
 *       LiveKit room NOW (otherwise they'd sit until their token expired).
 *
 * The insert MUST commit BEFORE the kick is issued. If the kick ran
 * concurrently a reconnect could land between the kick and the commit —
 * the row would still be pending and `/api/livekit-token` would mint a fresh
 * token for a user we were trying to ban. Awaiting the insert closes that
 * window: by the time `removeParticipant` runs the row is durable, so a
 * reconnect is already refused by the token route.
 *
 * A failed kick is tolerated (best-effort): the ban is already enforced at
 * token issuance, so the user is functionally banned regardless. We do NOT
 * roll back the insert on a kick failure.
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
  if (stream.seller_id === parsed.userId) {
    return NextResponse.json({ error: "Cannot ban yourself" }, { status: 400 });
  }

  // ── (a) insert the ban FIRST, await its commit ───────────────────────────
  // Upsert keeps it idempotent: re-banning a user who was already banned is
  // a 200 — the existing row persists (re-banning with a new reason doesn't
  // overwrite it; an "edit reason" would be a separate endpoint).
  const { error } = await supabase
    .from("stream_bans")
    .upsert({
      stream_id: parsed.streamId,
      user_id: parsed.userId,
      banned_by: user.id,
      reason: parsed.reason ?? "",
    })
    .eq("stream_id", parsed.streamId)
    .eq("user_id", parsed.userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // ── (b) kick the user from the LiveKit room NOW ─────────────────────────
  // Only AFTER the insert has committed. The participant identity matches the
  // one /api/livekit-token mints — the seller's UI passes the user's id as
  // the LiveKit identity when they joined.
  await banUser(stream.livekit_room_name, parsed.userId);

  return NextResponse.json({ ok: true });
}
