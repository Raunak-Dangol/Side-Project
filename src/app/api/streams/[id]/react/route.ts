import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const Body = z.object({
  kind: z.enum(["heart", "gift"]),
  // Capped to a sane per-call max to prevent abuse (a single request can't
  // inflate the counter by thousands). Clients batch taps every ~2s, so 50 is
  // far above any legitimate batch.
  amount: z.number().int().min(1).max(50),
});

/**
 * Adds to a stream's reaction counter via the SECURITY DEFINER
 * `increment_reaction` RPC. No direct table writes from the client — the
 * `reactions` table has no INSERT/UPDATE RLS policy, so only this server route
 * (service role) can mutate it. This is the one funnel through which all taps
 * flow, which is where rate-limiting / caps belong.
 *
 * The updated total is broadcast to every viewer via Supabase Realtime (the
 * `reactions` table is in the supabase_realtime publication).
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
    return NextResponse.json({ error: "Sign in to react" }, { status: 401 });
  }

  // Confirm the stream exists (avoid incrementing a dangling row).
  const { data: streamRow } = await supabase
    .from("streams")
    .select("id")
    .eq("id", streamId)
    .maybeSingle();
  if (!streamRow) {
    return NextResponse.json({ error: "Stream not found" }, { status: 404 });
  }

  const service = createSupabaseServiceClient();
  const { error } = await service.rpc("increment_reaction", {
    p_stream_id: streamId,
    p_kind: parsed.kind,
    p_amount: parsed.amount,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
