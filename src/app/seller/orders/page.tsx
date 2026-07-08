import { redirect } from "next/navigation";
import Navbar from "@/components/Navbar";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatNpr, timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface OrderRow {
  id: string;
  status: string;
  amount_cents: number;
  payment_gateway: string;
  gateway_transaction_id: string | null;
  created_at: string;
  product: { name: string } | null;
  buyer: { display_name: string | null } | null;
  stream: { title: string } | null;
}

export default async function SellerOrdersPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?redirect=/seller/orders");

  // RLS lets the seller read orders on their own products (via the join).
  // We fetch orders whose product belongs to this seller.
  const { data: products } = await supabase
    .from("products")
    .select("id")
    .eq("seller_id", user.id);

  const productIds = (products ?? []).map((p) => p.id);
  if (productIds.length === 0) {
    return (
      <>
        <Navbar />
        <EmptyOrders />
      </>
    );
  }

  const { data: orders } = await supabase
    .from("orders")
    .select(
      "id, status, amount_cents, payment_gateway, gateway_transaction_id, created_at, product:product_id(name), buyer:buyer_id(display_name), stream:stream_id(title)",
    )
    .in("product_id", productIds)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (orders as OrderRow[] | null) ?? [];

  return (
    <>
      <Navbar />
      <div className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-semibold mb-1">Orders</h1>
        <p className="text-sm text-slate-500 mb-6">
          Orders placed on your products during streams.
        </p>

        {rows.length === 0 ? (
          <EmptyOrders />
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium">Product</th>
                  <th className="px-4 py-2 font-medium">Buyer</th>
                  <th className="px-4 py-2 font-medium">Stream</th>
                  <th className="px-4 py-2 font-medium">Gateway</th>
                  <th className="px-4 py-2 font-medium">Amount</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">{o.product?.name ?? "—"}</td>
                    <td className="px-4 py-2">
                      {o.buyer?.display_name ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {o.stream?.title ?? "—"}
                    </td>
                    <td className="px-4 py-2 capitalize">{o.payment_gateway}</td>
                    <td className="px-4 py-2">{formatNpr(o.amount_cents)}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={o.status} />
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {timeAgo(o.created_at)} ago
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* TODO (post-prototype): fulfillment workflow, export to CSV, refunds UI */}
      </div>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    paid: "bg-emerald-100 text-emerald-700",
    pending: "bg-amber-100 text-amber-700",
    failed: "bg-rose-100 text-rose-700",
  };
  return (
    <span className={`badge ${styles[status] ?? "bg-slate-100"}`}>
      {status}
    </span>
  );
}

function EmptyOrders() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-1">Orders</h1>
      <p className="text-sm text-slate-500 mb-6">
        Orders placed on your products during streams.
      </p>
      <div className="card p-8 text-center text-slate-500">
        No orders yet.
      </div>
    </div>
  );
}
