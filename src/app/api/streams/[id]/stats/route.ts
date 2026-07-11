import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const Body = z.object({
  // Clamp at the API level too — a single client can't claim a million viewers.
  viewerCount: z.number().int().min(0).max(100_000),
});

/**
 * Upserts a stream's current viewer-count snapshot into `stream_stats`, used to
 * compute the hourly rank badge. Called periodically (~every 20s) by each
 * connected viewer's client.
 *
 * Write happens via the SERVICE ROLE: `stream_stats` has no client INSERT/UPDATE
 * RLS policy by design, so a malicious client can't fake a huge count to win
 * the rank badge. Auth is still required so we can rate-limit per viewer if
 * needed later.
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
