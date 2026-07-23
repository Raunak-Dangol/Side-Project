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

/** Stage-tagged logger — sanitized, no secrets, no raw data. */
function logStage(
  stage: string,
  streamId: string,
  extra: Record<string, unknown> = {},
) {
  console.error(`[telemetry:${stage}]`, { streamId, ...extra });
}

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
 *
 * Every stage logs its own sanitized error so a 500 in production reveals
 * the exact failing query + PostgREST code/message/details/hint without
 * exposing database internals to the browser.
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

  // ── Stage 1: authentication ────────────────────────────────────────────
  const supabase = await createSupabaseServerClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) {
    logStage("authentication", streamId, { reason: "no user" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Stage 2: stream ownership ──────────────────────────────────────────
  const { data: streamRow, error: streamErr } = await supabase
    .from("streams")
    .select("*")
    .eq("id", streamId)
    .single();
  if (streamErr || !streamRow) {
    logStage("stream_ownership", streamId, {
      reason: !streamRow ? "not found" : "query error",
      error: streamErr?.message,
      code: streamErr?.code,
    });
    return NextResponse.json({ error: "Stream not found" }, { status: 404 });
  }
  const stream = streamRow as Stream;
  if (stream.seller_id !== user.id) {
    logStage("stream_ownership", streamId, {
      reason: "not owner",
      sellerId: stream.seller_id,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Stage 3: paid orders aggregate (service role) ───────────────────────
  const service = createSupabaseServiceClient();

  // Try the full aggregate first (includes quantity, added in migration 0009).
  const { data: agg, error: aggErr } = await service
    .from("orders")
    .select("amount_cents:sum(amount_cents), quantity:sum(quantity), count()")
    .eq("stream_id", streamId)
    .eq("status", "paid")
    .maybeSingle();

  if (aggErr) {
    logStage("paid_orders_query", streamId, {
      stage: "primary",
      error: aggErr.message,
      code: aggErr.code,
      details: aggErr.details,
      hint: aggErr.hint,
    });

    // Fallback: quantity column may be missing (pre-migration-0009). Retry
    // with count + GMV only so the panel still renders.
    const { data: aggFallback, error: fallbackErr } = await service
      .from("orders")
      .select("amount_cents:sum(amount_cents), count()")
      .eq("stream_id", streamId)
      .eq("status", "paid")
      .maybeSingle();

    if (fallbackErr) {
      logStage("paid_orders_query", streamId, {
        stage: "fallback",
        error: fallbackErr.message,
        code: fallbackErr.code,
        details: fallbackErr.details,
        hint: fallbackErr.hint,
      });
      // Last resort: return zeros so the UI doesn't crash. The server log
      // has the real error for debugging.
      return NextResponse.json({
        gmv_cents: 0,
        units_sold: 0,
        orders_count: 0,
        conversion_rate: 0,
        viewer_count: 0,
      });
    }

    const fallbackRow = (aggFallback ?? {}) as {
      amount_cents: number | null;
      count: number | null;
    };
    const ordersCount = Number(fallbackRow.count ?? 0);
    const gmvCents = Number(fallbackRow.amount_cents ?? 0);

    // stream_stats for viewer count (fallback path).
    const { data: statsRowFB, error: statsErrFB } = await service
      .from("stream_stats")
      .select("viewer_count")
      .eq("stream_id", streamId)
      .maybeSingle();
    if (statsErrFB) {
      logStage("stream_stats_query", streamId, {
        stage: "fallback",
        error: statsErrFB.message,
        code: statsErrFB.code,
        details: statsErrFB.details,
        hint: statsErrFB.hint,
      });
    }
    const vcFB =
      Number(
        (statsRowFB as { viewer_count: number } | null)?.viewer_count ?? 0,
      ) || 0;

    return NextResponse.json({
      gmv_cents: gmvCents,
      units_sold: ordersCount, // pre-0009: 1 unit per order
      orders_count: ordersCount,
      conversion_rate: vcFB > 0 ? ordersCount / vcFB : 0,
      viewer_count: vcFB,
    });
  }

  // ── Stage 3b: null-safe aggregate parsing ──────────────────────────────
  // PostgREST returns null for sum() columns when no rows match, and may
  // return sum() as a string. Coerce to number with null→0 fallback.
  const row = (agg ?? {}) as {
    amount_cents: number | string | null;
    quantity: number | string | null;
    count: number | string | null;
  };
  const ordersCount = Number(row.count ?? 0) || 0;
  const gmvCents = Number(row.amount_cents ?? 0) || 0;
  const unitsSold = Number(row.quantity ?? 0) || 0;

  // ── Stage 4: stream_stats viewer count ──────────────────────────────────
  const { data: statsRow, error: statsErr } = await service
    .from("stream_stats")
    .select("viewer_count")
    .eq("stream_id", streamId)
    .maybeSingle();
  if (statsErr) {
    logStage("stream_stats_query", streamId, {
      stage: "primary",
      error: statsErr.message,
      code: statsErr.code,
      details: statsErr.details,
      hint: statsErr.hint,
    });
  }
  const viewerCount =
    Number(
      (statsRow as { viewer_count: number } | null)?.viewer_count ?? 0,
    ) || 0;

  // ── Stage 5: response aggregation ──────────────────────────────────────
  const conversionRate = viewerCount > 0 ? ordersCount / viewerCount : 0;

  return NextResponse.json({
    gmv_cents: gmvCents,
    units_sold: unitsSold,
    orders_count: ordersCount,
    conversion_rate: conversionRate,
    viewer_count: viewerCount,
  });
}
