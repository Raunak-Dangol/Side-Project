"use client";

import Link from "next/link";
import FollowButton from "@/components/FollowButton";
import type { StreamFeedSeller } from "@/lib/types";

interface StreamEndedCardProps {
  seller: StreamFeedSeller | null;
  /** Whether the viewer already follows this seller (optimistic seed). */
  initiallyFollowing?: boolean;
  /** Viewer id; hides the Follow affordance for the seller themselves / anon. */
  viewerId?: string | null;
  /** When provided, the primary CTA advances to the next live stream. */
  onNext?: () => void;
  /** When no next-stream handler is wired (e.g. /stream/[id] detail page). */
  detailMode?: boolean;
}

/**
 * "This stream has ended" overlay (plan §9.A). Shown when the active stream's
 * realtime status flips away from `live` while a viewer is watching — never a
 * silent black screen.
 *
 * In the feed (`onNext` provided): a Follow prompt + an auto-advancing primary
 * CTA that moves the viewer to the next live stream. On the detail page
 * (`detailMode`): the same reassurance with a "Back to feed" link instead.
 *
 * Presentational only — the status detection and auto-advance timer live in
 * StreamView / StreamFeed.
 */
export default function StreamEndedCard({
  seller,
  initiallyFollowing,
  viewerId,
  onNext,
  detailMode,
}: StreamEndedCardProps) {
  const canFollow = Boolean(seller && viewerId && viewerId !== seller.id);

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-hud flex items-center justify-center bg-cinema/85 px-6 text-center backdrop-blur-sm"
    >
      <div className="max-w-xs">
        <div className="mb-3 text-4xl" aria-hidden>
          📡
        </div>
        <h2 className="text-lg font-semibold text-white">
          This stream has ended
        </h2>
        <p className="mt-1.5 text-sm text-white/60">
          {seller?.display_name
            ? `${seller.display_name} went offline.`
            : "The creator went offline."}
        </p>

        {canFollow ? (
          <div className="mt-4 flex justify-center">
            <FollowButton
              targetId={seller!.id}
              initiallyFollowing={Boolean(initiallyFollowing)}
            />
          </div>
        ) : null}

        <div className="mt-4">
          {onNext ? (
            <button
              type="button"
              onClick={onNext}
              className="rounded-full bg-white/10 px-5 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Watch next live stream →
            </button>
          ) : (
            <Link
              href="/"
              className="inline-block rounded-full bg-white/10 px-5 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              {detailMode ? "Back to feed" : "Browse streams"}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
