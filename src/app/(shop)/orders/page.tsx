import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { formatNpr } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface BuyerOrderRow {
  id: string;
  status: string;
  amount_cents: number;
  payment_gateway: string;
  gateway_transaction_id: string | null;
  created_at: string;
  product: { name: string } | null;
  stream: { title: string } | null;
}

export default async function BuyerOrdersPage() {
  const supabase = await createSupabaseServerClient();
  const user = await getAuthenticatedUser(supabase);

  if (!user) redirect("/login?redirect=/orders");

  // RLS allows a buyer to read their own orders (buyer_id = auth.uid()).
  const { data: orders } = await supabase
    .from("orders")
    .select(
      "id, status, amount_cents, payment_gateway, gateway_transaction_id, created_at, product:product_id(name), stream:stream_id(title)",
    )
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (orders as BuyerOrderRow[] | null) ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-1">Your orders</h1>
      <p className="text-sm text-slate-500 mb-6">
        Your purchases from live streams.
      </p>

      {rows.length === 0 ? (
        <div className="card p-8 text-center text-slate-500">
          No orders yet.{" "}
          <Link href="/" className="text-gold-dark underline">
            Browse live streams
          </Link>
          .
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Product</th>
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
                  <td className="px-4 py-2 font-medium text-slate-800">
                    {o.product?.name ?? "—"}
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
                    {new Date(o.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
