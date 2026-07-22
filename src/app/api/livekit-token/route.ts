import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { generateLiveKitToken } from "@/lib/livekit";
import type { Stream } from "@/lib/types";

const Body = z.object({
  streamId: z.string().uuid(),
  role: z.enum(["seller", "viewer"]),
  identity: z.string().min(1).max(120),
  name: z.string().max(120).optional(),
});

/**
 * Issues a scoped LiveKit token.
 *  - Seller token: canPublish = true (only if the caller actually owns the stream)
 *  - Viewer token: canPublish = false, canSubscribe = true
 *
 * Tokens are short-lived and scoped to the single stream's room.
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

  const { data: streamRow, error } = await supabase
    .from("streams")
    .select("*")
    .eq("id", parsed.streamId)
    .single();
  if (error || !streamRow) {
    return NextResponse.json({ error: "Stream not found" }, { status: 404 });
  }
  const stream = streamRow as Stream;

  // Seller-publish rights require BOTH the caller asking for "seller" AND
  // actually owning the stream. A viewer can never escalate to publish.
  const isOwner = !!user && user.id === stream.seller_id;
  const canPublish = parsed.role === "seller" && isOwner;

  // Phase 4 (P4-D): reject banned viewers at token issuance. The ban route
  // inserts into `stream_bans` BEFORE calling removeParticipant, so by the
  // time a reconnect lands here the row is already durable — the user can't
  // slip back in during the kick→insert window. The session client works:
  // the `stream_bans_select_all` RLS policy is open (`using (true)`), so
  // every viewer can read the ban list — the enforcement here is the
  // authoritative gate, not the read.
  if (user) {
    const { data: banRow } = await supabase
      .from("stream_bans")
      .select("user_id")
      .eq("stream_id", parsed.streamId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (banRow) {
      return NextResponse.json(
        { error: "You are banned from this stream." },
        { status: 403 },
      );
    }
  }

  try {
    const token = await generateLiveKitToken({
      roomName: stream.livekit_room_name,
      participantIdentity: parsed.identity,
      participantName: parsed.name,
      canPublish,
    });
    return NextResponse.json({ token });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Token generation failed" },
      { status: 500 },
    );
  }
}
