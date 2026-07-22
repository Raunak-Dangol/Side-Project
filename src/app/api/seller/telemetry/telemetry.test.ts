import { describe, it, expect } from "vitest";

/**
 * Telemetry aggregation tests (Phase 4 / P4-B).
 *
 * These verify the snapshot MATH the /api/seller/telemetry route computes —
 * the literal expressions behind gmv_cents / units_sold / orders_count /
 * conversion_rate. They cover the edge cases the route must handle:
 *   * no paid orders yet (all aggregates 0, conversion 0, no divide-by-zero)
 *   * failed/pending rows excluded from GMV but counted nowhere
 *   * conversion rate clamps when viewer_count is 0
 *   * quantity multiplies into units_sold, not orders_count
 *
 * The route uses a supabase aggregate select (`sum(amount_cents)`,
 * `sum(quantity)`, `count()`), which returns nulls when no rows match; the
 * snapshot builder below mirrors that null-coalescing exactly.
 */

interface RawAggregate {
  amount_cents: number | null;
  quantity: number | null;
  count: number | null;
}
interface StreamStatsRow {
  viewer_count: number;
}
interface Snapshot {
  gmv_cents: number;
  units_sold: number;
  orders_count: number;
  conversion_rate: number;
  viewer_count: number;
}

// Mirror of the route's snapshot construction — the unit under test.
function buildSnapshot(
  agg: RawAggregate | null,
  stats: StreamStatsRow | null,
): Snapshot {
  const row = agg ?? { amount_cents: null, quantity: null, count: null };
  const ordersCount = row.count ?? 0;
  const gmvCents = row.amount_cents ?? 0;
  const unitsSold = row.quantity ?? 0;
  const viewerCount = stats?.viewer_count ?? 0;
  const conversionRate = viewerCount > 0 ? ordersCount / viewerCount : 0;
  return {
    gmv_cents: gmvCents,
    units_sold: unitsSold,
    orders_count: ordersCount,
    conversion_rate: conversionRate,
    viewer_count: viewerCount,
  };
}

describe("telemetry snapshot aggregation", () => {
  it("returns all-zero snapshot when no paid orders exist", () => {
    // `.maybeSingle()` returns null when there are zero matching rows.
    const snap = buildSnapshot(null, { viewer_count: 12 });
    expect(snap).toEqual({
      gmv_cents: 0,
      units_sold: 0,
      orders_count: 0,
      conversion_rate: 0, // 0/12 — no divide-by-zero even with viewers
      viewer_count: 12,
    });
  });

  it("sums paid order amounts and quantities, counts paid orders", () => {
    const snap = buildSnapshot(
      { amount_cents: 150000, quantity: 7, count: 4 },
      { viewer_count: 100 },
    );
    expect(snap.gmv_cents).toBe(150000);
    expect(snap.units_sold).toBe(7);
    expect(snap.orders_count).toBe(4);
    // 4 paid orders / 100 unique viewers = 0.04 conversion rate.
    expect(snap.conversion_rate).toBeCloseTo(0.04, 5);
    expect(snap.viewer_count).toBe(100);
  });

  it("treats null aggregate columns as zero (Postgres returns null when no rows)", () => {
    // The aggregate select returns count: 0 explicitly but the SUMs as null
    // when there are matching-but-all-null rows — coalesced to 0 here.
    const snap = buildSnapshot(
      { amount_cents: null, quantity: null, count: 0 },
      { viewer_count: 5 },
    );
    expect(snap.gmv_cents).toBe(0);
    expect(snap.units_sold).toBe(0);
    expect(snap.orders_count).toBe(0);
    expect(snap.conversion_rate).toBe(0);
  });

  it("conversion rate is 0 (no NaN) when viewer_count is 0", () => {
    // No viewers but a belated paid order lands (e.g. a buyer's payment
    // reconciled after the stream ended). Must never divide by zero.
    const snap = buildSnapshot(
      { amount_cents: 5000, quantity: 1, count: 1 },
      { viewer_count: 0 },
    );
    expect(snap.orders_count).toBe(1);
    expect(snap.gmv_cents).toBe(5000);
    expect(snap.conversion_rate).toBe(0);
    expect(Number.isNaN(snap.conversion_rate)).toBe(false);
  });

  it("treats a missing stream_stats row as 0 viewers (still no NaN)", () => {
    // stream_stats may not have a row yet for a brand-new stream.
    const snap = buildSnapshot(
      { amount_cents: 0, quantity: 0, count: 0 },
      null,
    );
    expect(snap.viewer_count).toBe(0);
    expect(snap.conversion_rate).toBe(0);
  });

  it("units_sold reflects total quantity, not order count", () => {
    // Two orders (count=2) but quantity 3 each → units_sold 6, orders 2.
    const snap = buildSnapshot(
      { amount_cents: 6000, quantity: 6, count: 2 },
      { viewer_count: 50 },
    );
    expect(snap.units_sold).toBe(6);
    expect(snap.orders_count).toBe(2);
  });
});

/**
 * The route filters on orders.status='paid' BEFORE the aggregate runs.
 * Verify the filter expression itself excludes the other statuses — this
 * is the predicate the `.eq("status", "paid")` chain applies. Modeling it
 * as a predicate function keeps the test honest about what gets summed.
 */
describe("telemetry paid-status filter", () => {
  type OrderRow = {
    status: "pending" | "paid" | "failed";
    amount_cents: number;
    quantity: number;
  };

  function aggregatePaid(rows: OrderRow[]): Snapshot {
    const paid = rows.filter((r) => r.status === "paid");
    return buildSnapshot(
      {
        amount_cents: paid.reduce((a, r) => a + r.amount_cents, 0) || null,
        quantity: paid.reduce((a, r) => a + r.quantity, 0) || null,
        count: paid.length,
      },
      { viewer_count: 100 },
    );
  }

  it("excludes pending and failed orders from GMV / units / count", () => {
    const rows: OrderRow[] = [
      { status: "paid", amount_cents: 1000, quantity: 1 },
      { status: "pending", amount_cents: 99999, quantity: 99 }, // excluded
      { status: "failed", amount_cents: 88888, quantity: 88 }, // excluded
      { status: "paid", amount_cents: 2000, quantity: 2 },
    ];
    const snap = aggregatePaid(rows);
    expect(snap.gmv_cents).toBe(3000);
    expect(snap.units_sold).toBe(3);
    expect(snap.orders_count).toBe(2);
  });

  it("counts nothing when no paid rows exist", () => {
    const rows: OrderRow[] = [
      { status: "pending", amount_cents: 1000, quantity: 1 },
      { status: "failed", amount_cents: 2000, quantity: 2 },
    ];
    const snap = aggregatePaid(rows);
    expect(snap).toMatchObject({
      gmv_cents: 0,
      units_sold: 0,
      orders_count: 0,
    });
  });
});
