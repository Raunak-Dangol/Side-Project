"use client";

import { useRouter } from "next/navigation";
import type { StreamFeedSeller } from "@/lib/types";
import { initials } from "@/lib/utils";

export interface PresenceViewer {
  id: string;
  display_name: string | null;
}

interface TopBarProps {
  seller: StreamFeedSeller | null;
  /** Whether the seller's account is marked verified (SQL-only flag). */
  verified: boolean;
  viewerCount: number;
  /** Last few distinct viewers who joined (most-recent first), max ~3. */
  recentViewers: PresenceViewer[];
}

/**
 * Top-of-stream identity bar: seller avatar/name (+ verified badge), live viewer
 * count, an avatar stack of recent joiners, and a close button. Presentational
 * only — all counts and the viewer list come from StreamView's presence channel.
 */
export default function TopBar({
  seller,
  verified,
  viewerCount,
  recentViewers,
}: TopBarProps) {
  const router = useRouter();

  return (
    <div className="absolute left-[12px] right-[12px] top-[12px] z-10 flex items-center gap-2">
      {/* Seller identity */}
      <div className="flex items-center gap-2 rounded-full bg-black/40 py-1 pl-1 pr-3 backdrop-blur-sm">
        <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-primary text-xs font-semibold text-primary-50">
          {seller?.display_name ? (
            initials(seller.display_name)
          ) : (
            <span aria-hidden>?</span>
          )}
        </div>
        <div className="flex flex-col leading-tight">
          <div className="flex items-center gap-1">
            <span className="max-w-[120px] truncate text-xs font-medium text-white">
              {seller?.display_name ?? "Unknown seller"}
            </span>
            {verified ? (
              <span
                title="Verified seller"
                aria-label="Verified seller"
                className="inline-flex items-center rounded-full border border-gold bg-black/30 px-1 text-[9px] font-medium text-gold-light"
              >
                ✓
              </span>
            ) : null}
          </div>
          <span className="text-[10px] text-white/70">
            {viewerCount} watching
          </span>
        </div>
      </div>

      {/* Avatar stack of recent joiners */}
      {recentViewers.length > 0 ? (
        <div className="flex -space-x-2">
          {recentViewers.slice(0, 3).map((v) => (
            <div
              key={v.id}
              title={v.display_name ?? "Viewer"}
              className="flex h-6 w-6 items-center justify-center rounded-full border border-black/40 bg-slate-600 text-[9px] font-semibold text-white"
            >
              {initials(v.display_name)}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex-1" />

      {/* Close → back to stream list (the ONLY way back; no Navbar on this page) */}
      <button
        type="button"
        onClick={() => router.push("/")}
        aria-label="Leave stream"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition hover:bg-black/60"
      >
        ✕
      </button>
    </div>
  );
}
