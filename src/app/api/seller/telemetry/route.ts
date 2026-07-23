import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import type { Stream } from "@/lib/types";

const Query = z.object({
  streamId: z.string().uuid(),
});

/**
 * GET /api/seller/telemetry?streamId=...
 *
 * Seller-only. Returns the INITIAL snapshot only — the client then subscribes
 * to the `orders` realtime channel and increments these values live as sales
 * land (GMV ticks the instant a sale is confirmed, not on a poll).
 *
 * Snapshot fields:
 *   * gmv_cents       — sum of amount_cents for paid orders on this stream
 *   * units_sold      — sum of quantity for paid orders
 *   * orders_count    — count of paid orders
 *   * conversion_rate — paid orders / unique viewers (from stream_stats), 0-1
 *                       (0 when viewer_count is 0 — no division-by-zero)
 *
 * Reader (snapshot) reads use the SERVICE ROLE client. Aggregating across
 * many rows through the RLS client would be a fan-out the database handles
 * better directly, and the seller-ownership gate is enforced BEFORE any
 * aggregation query runs (we 403 non-owners). The ownership check itself
 * uses the session (anon-key) client so it respects the caller's auth.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const parsed = Query.safeParse({
    streamId: url.searchParams.get("streamId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { streamId } = parsed.data;

  // Ownership gate — session client. A non-seller or non-owner gets 403
  // BEFORE any service-role query runs; the service client never sees the
  // request otherwise.
  const supabase = await createSupabaseServerClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: streamRow } = await supabase
    .from("streams")
    .select("*")
    .eq("id", streamId)
    .single();
  if (!streamRow) {
    return NextResponse.json({ error: "Stream not found" }, { status: 404 });
  }
  const stream = streamRow as Stream;
  if (stream.seller_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Aggregation runs through the service client (bypasses RLS — but we've
  // already proven the caller owns this stream, so the read is authorized).
  const service = createSupabaseServiceClient();

  // One pass: sum amount_cents + quantity, count rows, for paid orders only.
  // `.maybeSingle()` because an aggregate select with no group-by returns
  // exactly one row (null columns when there are no matching orders).
  //
  // If migration 0009 (which adds the `quantity` column) hasn't been applied,
  // `sum(quantity)` fails with a 4xx/5xx from PostgREST. We fall back to a
  // quantity-less aggregate (count + GMV only) so the telemetry panel still
  // renders instead of 500-ing the whole route.
  const { data: agg, error: aggErr } = await service
    .from("orders")
    .select("amount_cents:sum(amount_cents), quantity:sum(quantity), count()")
    .eq("stream_id", streamId)
    .eq("status", "paid")
    .maybeSingle();
  if (aggErr) {
    console.error("[telemetry] aggregate query failed", {
      streamId,
      error: aggErr.message,
      code: aggErr.code,
      details: aggErr.details,
      hint: aggErr.hint,
    });
    // Fallback: try without the `quantity` column (pre-0009 schema).
    const { data: aggFallback, error: fallbackErr } = await service
      .from("orders")
      .select("amount_cents:sum(amount_cents), count()")
      .eq("stream_id", streamId)
      .eq("status", "paid")
      .maybeSingle();
    if (fallbackErr) {
      console.error("[telemetry] fallback aggregate also failed", {
        streamId,
        error: fallbackErr.message,
        code: fallbackErr.code,
      });
      return NextResponse.json(
        { error: "Telemetry query failed" },
        { status: 500 },
      );
    }
    const fallbackRow = (aggFallback ?? {}) as {
      amount_cents: number | null;
      count: number | null;
    };
    const ordersCount = fallbackRow.count ?? 0;
    const gmvCents = fallbackRow.amount_cents ?? 0;
    const { data: statsRowFB, error: statsErrFB } = await service
      .from("stream_stats")
      .select("viewer_count")
      .eq("stream_id", streamId)
      .maybeSingle();
    if (statsErrFB) {
      console.error("[telemetry] stream_stats query failed", {
        streamId,
        error: statsErrFB.message,
        code: statsErrFB.code,
      });
    }
    const vcFB =
      (statsRowFB as { viewer_count: number } | null)?.viewer_count ?? 0;
    return NextResponse.json({
      gmv_cents: gmvCents,
      units_sold: ordersCount, // pre-0009: 1 unit per order
      orders_count: ordersCount,
      conversion_rate: vcFB > 0 ? ordersCount / vcFB : 0,
      viewer_count: vcFB,
    });
  }

  // The aggregate row shape from supabase-js: the aliased sums are numeric
  // (or null when no rows), and `count` is a number.
  const row = (agg ?? {}) as {
    amount_cents: number | null;
    quantity: number | null;
    count: number | null;
  };
  const ordersCount = row.count ?? 0;
  const gmvCents = row.amount_cents ?? 0;
  const unitsSold = row.quantity ?? 0;

  // Unique viewers come from stream_stats.viewer_count (the presence-backed
  // counter maintained by StreamView). conversion_rate is paid orders over
  // unique viewers; 0 when there are no viewers (no divide-by-zero).
  const { data: statsRow, error: statsErr } = await service
    .from("stream_stats")
    .select("viewer_count")
    .eq("stream_id", streamId)
    .maybeSingle();
  if (statsErr) {
    console.error("[telemetry] stream_stats query failed", {
      streamId,
      error: statsErr.message,
      code: statsErr.code,
      details: statsErr.details,
      hint: statsErr.hint,
    });
  }
  const viewerCount = (statsRow as { viewer_count: number } | null)?.viewer_count ?? 0;
  const conversionRate = viewerCount > 0 ? ordersCount / viewerCount : 0;

  return NextResponse.json({
    gmv_cents: gmvCents,
    units_sold: unitsSold,
    orders_count: ordersCount,
    conversion_rate: conversionRate,
    viewer_count: viewerCount,
  });
}
