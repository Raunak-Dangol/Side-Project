import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Stream } from "@/lib/types";

const Body = z.object({
  // Empty string → clears (treated as null). Truncate absurdly long values.
  promo_banner_text: z.string().trim().max(140).optional().nullable(),
  // Optional link; validated as a URL when present.
  promo_banner_link: z
    .string()
    .trim()
    .url()
    .max(500)
    .optional()
    .or(z.literal("").transform(() => null))
    .nullable(),
});

/**
 * Sets (or clears) a stream's promo banner text/link. The caller must own the
 * stream (the write goes through their session, which RLS gates to their own
 * streams — same shape as /api/pin-product). The update propagates to all
 * viewers via Supabase Realtime (the streams table is in the publication).
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

  // Confirm ownership.
  const { data: streamRow, error: sErr } = await supabase
    .from("streams")
    .select("*")
    .eq("id", streamId)
    .single();
  if (sErr || !streamRow) {
    return NextResponse.json({ error: "Stream not found" }, { status: 404 });
  }
  const stream = streamRow as Stream;
  if (stream.seller_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Normalize empty strings → null so empty == "no banner".
  const text = parsed.promo_banner_text?.trim() || null;
  const link = parsed.promo_banner_link || null;

  const { data, error } = await supabase
    .from("streams")
    .update({ promo_banner_text: text, promo_banner_link: link })
    .eq("id", streamId)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(data);
}
