import Navbar from "@/components/Navbar";
import StreamCard from "@/components/StreamCard";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { StreamWithRelations } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();

  const { data: streams } = await supabase
    .from("streams")
    .select(
      "*, seller:seller_id(id, display_name), pinned_product:pinned_product_id(*)",
    )
    .order("created_at", { ascending: false })
    .limit(50);

  const live = (streams as StreamWithRelations[] | null)?.filter(
    (s) => s.status === "live",
  );
  const upcoming = (streams as StreamWithRelations[] | null)?.filter(
    (s) => s.status === "scheduled",
  );
  const ended = (streams as StreamWithRelations[] | null)?.filter(
    (s) => s.status === "ended",
  );

  return (
    <>
      <Navbar />
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold mb-1">Live streams</h1>
        <p className="text-sm text-slate-500 mb-6">
          Watch live shopping, chat with the seller, and buy in a tap.
        </p>

        {live && live.length > 0 ? (
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-rose-600 uppercase tracking-wide mb-3">
              On now
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {live.map((s) => (
                <StreamCard key={s.id} stream={s} />
              ))}
            </div>
          </section>
        ) : null}

        {upcoming && upcoming.length > 0 ? (
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-amber-600 uppercase tracking-wide mb-3">
              Upcoming
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {upcoming.map((s) => (
                <StreamCard key={s.id} stream={s} />
              ))}
            </div>
          </section>
        ) : null}

        {ended && ended.length > 0 ? (
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
              Past streams
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {ended.map((s) => (
                <StreamCard key={s.id} stream={s} />
              ))}
            </div>
          </section>
        ) : null}

        {(!streams || streams.length === 0) && (
          <div className="card p-8 text-center text-slate-500">
            No streams yet.{" "}
            {/* TODO (post-prototype): show curated/featured seller streams here */}
            Sellers can create one from the dashboard.
          </div>
        )}
      </div>
    </>
  );
}
