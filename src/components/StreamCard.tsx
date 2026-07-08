import Link from "next/link";
import type { StreamWithRelations } from "@/lib/types";
import { formatNpr } from "@/lib/utils";

const statusStyles: Record<string, string> = {
  live: "bg-rose-100 text-rose-700",
  scheduled: "bg-amber-100 text-amber-700",
  ended: "bg-slate-100 text-slate-500",
};

export default function StreamCard({ stream }: { stream: StreamWithRelations }) {
  return (
    <Link href={`/stream/${stream.id}`} className="card block overflow-hidden hover:shadow-md transition">
      <div className="aspect-video bg-slate-900 relative">
        {stream.status === "live" ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-3 w-3 mr-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75 animate-ping" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500" />
            </span>
            <span className="text-white font-medium">LIVE</span>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/70 text-sm">
            {stream.status === "scheduled" ? "Scheduled" : "Stream ended"}
          </div>
        )}
        <span
          className={`badge absolute top-2 left-2 ${statusStyles[stream.status] ?? "bg-slate-100"}`}
        >
          {stream.status}
        </span>
      </div>
      <div className="p-3">
        <h3 className="font-medium text-slate-900 truncate">{stream.title}</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          by {stream.seller?.display_name ?? "Unknown seller"}
        </p>
        {stream.pinned_product ? (
          <p className="text-xs text-slate-600 mt-2 truncate">
            📌 {stream.pinned_product.name} · {formatNpr(stream.pinned_product.price_cents)}
          </p>
        ) : null}
      </div>
    </Link>
  );
}
