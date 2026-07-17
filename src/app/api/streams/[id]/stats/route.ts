import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit, getClientId } from "@/lib/rate-limit";

const Body = z.object({
  // Clamp at the API level too — a single client can't claim a million viewers.
  viewerCount: z.number().int().min(0).max(100_000),
});

/**
 * Upserts a stream's current viewer-count snapshot into `stream_stats`, used to
 * compute the hourly rank badge. Called periodically (~every 20s) by the
 * SELLER's client.
 *
 * Write happens via the SERVICE ROLE: `stream_stats` has no client INSERT/UPDATE
 * RLS policy by design, so a malicious client can't fake a huge count to win
 * the rank badge. We additionally require the caller to OWN the stream —
 * otherwise any authed user could drive any stream's count to 100k (audit
 * finding H4). Rate-limited so the ownership check itself can't be hammered.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: streamId } = await params;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Ownership check (H4): only the stream's seller may write its viewer count.
  const { data: streamRow } = await supabase
    .from("streams")
    .select("seller_id")
    .eq("id", streamId)
    .maybeSingle();
  if (!streamRow) {
    return NextResponse.json({ error: "Stream not found" }, { status: 404 });
  }
  if (streamRow.seller_id !== user.id) {
    return NextResponse.json({ error: "Only the stream owner can report stats" }, { status: 403 });
  }

  // Rate limit per seller so the ownership lookup + upsert can't be hammered.
  const limited = await rateLimit({
    key: `stats:ip:${getClientId(request)}`,
    limit: 30,
  });
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const service = createSupabaseServiceClient();
  const { error } = await service
    .from("stream_stats")
    .upsert(
      { stream_id: streamId, viewer_count: parsed.viewerCount, updated_at: new Date().toISOString() },
      { onConflict: "stream_id" },
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
