import { describe, it, expect, vi, beforeEach } from "vitest";
import { callFulfillOrder, fulfillRedirect } from "@/lib/payments/fulfill";

/**
 * Tests for the shared fulfill_order RPC helper.
 *
 * These verify:
 *   - exact RPC argument names (p_order, NOT p_order_id)
 *   - scalar result parsing (paid / already_handled / oversold / not_found)
 *   - RPC error → "error" outcome (never misclassified as not_found)
 *   - null/unknown result → "error" outcome
 *   - redirect URLs use orderId (not order)
 *   - downstream exception never becomes not_found
 *   - callback and return page parameter agreement
 */

// Minimal mock SupabaseClient — we only care about the .rpc() call.
function mockService(returnData: unknown, returnError?: unknown) {
  const rpc = vi.fn().mockResolvedValue({
    data: returnData,
    error: returnError ?? null,
  });
  // Cast through unknown — the real SupabaseClient rpc() signature is complex
  // but we only need the call args + return value for these tests.
  return { rpc } as unknown as Parameters<typeof callFulfillOrder>[0];
}


describe("callFulfillOrder — RPC argument names", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("calls rpc with p_order (not p_order_id)", async () => {
    const service = mockService("paid");
    await callFulfillOrder(service, {
      orderId: "order-123",
      transactionId: "txn-456",
      khaltiPidx: "pidx-789",
    });
    const call = (service as any).rpc.mock.calls[0]!;
    expect(call[0]).toBe("fulfill_order");
    const args = call[1] as Record<string, unknown>;
    expect(args.p_order).toBe("order-123");
    expect(args.p_order_id).toBeUndefined();
  });

  it("passes p_transaction_id and p_khalti_pidx", async () => {
    const service = mockService("paid");
    await callFulfillOrder(service, {
      orderId: "order-123",
      transactionId: "txn-456",
      khaltiPidx: "pidx-789",
    });
    const args = (service as any).rpc.mock
      .calls[0]![1] as Record<string, unknown>;
    expect(args.p_transaction_id).toBe("txn-456");
    expect(args.p_khalti_pidx).toBe("pidx-789");
  });

  it("passes null p_khalti_pidx when not provided", async () => {
    const service = mockService("paid");
    await callFulfillOrder(service, {
      orderId: "order-123",
      transactionId: "txn-456",
    });
    const args = (service as any).rpc.mock
      .calls[0]![1] as Record<string, unknown>;
    expect(args.p_khalti_pidx).toBeNull();
  });
});

describe("callFulfillOrder — scalar result parsing", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("parses 'paid' result", async () => {
    const service = mockService("paid");
    const { outcome } = await callFulfillOrder(service, {
      orderId: "o1",
      transactionId: "t1",
    });
    expect(outcome).toBe("paid");
  });

  it("parses 'already_handled' result (idempotent replay)", async () => {
    const service = mockService("already_handled");
    const { outcome } = await callFulfillOrder(service, {
      orderId: "o1",
      transactionId: "t1",
    });
    expect(outcome).toBe("already_handled");
  });

  it("parses 'oversold' result", async () => {
    const service = mockService("oversold");
    const { outcome } = await callFulfillOrder(service, {
      orderId: "o1",
      transactionId: "t1",
    });
    expect(outcome).toBe("oversold");
  });

  it("parses 'not_found' result", async () => {
    const service = mockService("not_found");
    const { outcome } = await callFulfillOrder(service, {
      orderId: "o1",
      transactionId: "t1",
    });
    expect(outcome).toBe("not_found");
  });
});

describe("callFulfillOrder — error handling", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("RPC error returns outcome 'error' (never not_found)", async () => {
    const service = mockService(null, {
      code: "PGRST202",
      message: "Could not find the function",
      details: null,
      hint: null,
    });
    const { outcome } = await callFulfillOrder(service, {
      orderId: "o1",
      transactionId: "t1",
    });
    expect(outcome).toBe("error");
    expect(outcome).not.toBe("not_found");
  });

  it("null result returns outcome 'error' (never not_found)", async () => {
    const service = mockService(null);
    const { outcome } = await callFulfillOrder(service, {
      orderId: "o1",
      transactionId: "t1",
    });
    expect(outcome).toBe("error");
  });

  it("unknown string result returns outcome 'error'", async () => {
    const service = mockService("something_unexpected");
    const { outcome } = await callFulfillOrder(service, {
      orderId: "o1",
      transactionId: "t1",
    });
    expect(outcome).toBe("error");
  });

  it("downstream exception never becomes not_found", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("Network failure"));
    const service = { rpc } as unknown as Parameters<typeof callFulfillOrder>[0];
    let caught = false;
    try {
      await callFulfillOrder(service, {
        orderId: "o1",
        transactionId: "t1",
      });
    } catch {
      caught = true;
    }
    // The helper lets the exception propagate — callers must try/catch.
    // But the important invariant: it never returns "not_found" for a found order.
    expect(caught).toBe(true);
  });
});

describe("fulfillRedirect — URL parameter agreement", () => {
  it("uses orderId (not order) for paid", () => {
    const url = fulfillRedirect("paid", "order-abc");
    expect(url).toContain("orderId=order-abc");
    expect(url).toContain("status=paid");
    expect(url).not.toContain("order=");
  });

  it("uses orderId for already_handled", () => {
    const url = fulfillRedirect("already_handled", "order-abc");
    expect(url).toContain("orderId=order-abc");
    expect(url).toContain("status=paid");
  });

  it("uses orderId for oversold", () => {
    const url = fulfillRedirect("oversold", "order-abc");
    expect(url).toContain("orderId=order-abc");
    expect(url).toContain("status=oversold");
  });

  it("uses orderId for error", () => {
    const url = fulfillRedirect("error", "order-abc");
    expect(url).toContain("orderId=order-abc");
    expect(url).toContain("status=error");
  });

  it("not_found has no orderId (order was never found)", () => {
    const url = fulfillRedirect("not_found", "irrelevant");
    expect(url).toContain("status=not_found");
    expect(url).not.toContain("orderId=");
  });
});

describe("duplicate callback idempotency", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("two calls with already_handled both return already_handled", async () => {
    const service = mockService("already_handled");
    const r1 = await callFulfillOrder(service, {
      orderId: "o1",
      transactionId: "t1",
    });
    const r2 = await callFulfillOrder(service, {
      orderId: "o1",
      transactionId: "t1",
    });
    expect(r1.outcome).toBe("already_handled");
    expect(r2.outcome).toBe("already_handled");
    // Both redirect to paid — no double-fulfillment, no error.
    expect(fulfillRedirect(r1.outcome, "o1")).toContain("status=paid");
    expect(fulfillRedirect(r2.outcome, "o1")).toContain("status=paid");
  });
});
