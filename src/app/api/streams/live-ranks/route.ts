import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Returns the current rank ordering across all LIVE streams, by viewer count.
 * RankBadge uses this to show "hourly rank #{n}" for the stream it's on.
 *
 * `stream_stats` holds the latest viewer-count snapshot each client periodically
 * POSTs; a stream with no stats row yet (just went live) is treated as 0 and
 * ranks last. Computed with a window `rank()`, mirroring the spec's query.
 *
 * Read via the service role so any viewer (anon included) can fetch ranks —
 * `stream_stats` RLS does allow anon SELECT, but using the service client keeps
 * the read path uniform with the other stream-* routes.
 */
export async function GET() {
  const service = createSupabaseServiceClient();

  // Left-join streams→stream_stats so live streams without a stats row still
  // appear (coalesced to 0 viewers). Only status='live' streams are ranked.
  const { data, error } = await service
    .from("streams")
    .select("id, stream_stats(viewer_count)")
    .eq("status", "live");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type Row = {
    id: string;
    stream_stats: { viewer_count: number } | { viewer_count: number }[] | null;
  };

  const ranked = ((data as Row[]) ?? [])
    .map((r) => {
      // stream_stats comes back as an array from the join; normalize to a number.
      const stats = Array.isArray(r.stream_stats) ? r.stream_stats[0] : r.stream_stats;
      const viewerCount = stats?.viewer_count ?? 0;
      return { id: r.id, viewerCount };
    })
    .sort((a, b) => b.viewerCount - a.viewerCount)
    .map((s, i) => ({ id: s.id, rank: i + 1 }));

  return NextResponse.json({ ranks: ranked });
}
