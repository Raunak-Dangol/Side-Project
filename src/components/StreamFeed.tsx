"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import StreamView from "@/components/stream/StreamView";
import type { StreamFeedItem } from "@/lib/types";

interface StreamFeedProps {
  streams: StreamFeedItem[];
  viewerId: string | null;
  viewerName: string | null;
}

/**
 * TikTok-style vertical discovery feed.
 *
 * Owns the SINGLE `activeIndex`. A stream is active only when it is both the
 * centered slide AND the document is visible. Only the active slide mounts
 * `<StreamView>` (and therefore LiveKit + Supabase Realtime + presence +
 * polling). Inactive slides render a cheap static poster — they never mount
 * StreamView, so they can never accidentally open a video room or realtime
 * channel. The one-connection invariant is enforced structurally here, not by
 * relying on downstream cleanup.
 *
 * `visibilitychange`: when the tab hides we deactivate the current stream so it
 * releases LiveKit/Realtime/presence/polling; when it returns we reactivate the
 * centered slide.
 */
export default function StreamFeed({
  streams,
  viewerId,
  viewerName,
}: StreamFeedProps) {
  const router = useRouter();
  const [activeIndex, setActiveIndex] = useState(0);
  const [documentVisible, setDocumentVisible] = useState(true);

  // Stable ref collection for each slide, keyed by index. A ref array (rather
  // than a map) is simplest because slide order never changes during the feed's
  // lifetime.
  const containerRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLElement | null)[]>([]);

  // Clamp activeIndex if the stream list shrinks (e.g. a stream goes offline and
  // is removed). Guarantees `streams[activeIndex]` is always valid.
  useEffect(() => {
    if (activeIndex > streams.length - 1) {
      setActiveIndex(Math.max(0, streams.length - 1));
    }
  }, [streams.length, activeIndex]);

  // ── Active-slide detection: ONE IntersectionObserver over all slides ──
  // Among every currently-intersecting entry, pick the highest ratio and switch
  // only if that ratio is ≥ 0.6. Relying on callback order is unsafe because
  // multiple slides can cross the threshold in the same frame during a swipe.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let bestIndex: number | null = null;
        let bestRatio = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number(
            (entry.target as HTMLElement).dataset.feedIndex,
          );
          if (entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio;
            bestIndex = idx;
          }
        }
        if (bestIndex !== null && bestRatio >= 0.6) {
          setActiveIndex(bestIndex);
        }
      },
      {
        root,
        threshold: [0.25, 0.5, 0.6, 0.75, 1],
      },
    );

    for (const el of slideRefs.current) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [streams.length]);

  // ── visibilitychange: release resources when the tab is hidden ──
  useEffect(() => {
    const onVisibility = () => {
      setDocumentVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const goBrowse = useCallback(() => router.push("/browse"), [router]);

  // Per-stream role: a user is "seller" only on their OWN stream.
  const roleFor = useCallback(
    (stream: StreamFeedItem): "seller" | "viewer" =>
      viewerId && stream.seller_id === viewerId ? "seller" : "viewer",
    [viewerId],
  );

  return (
    <div className="relative h-dvh w-full bg-black">
      <div
        ref={containerRef}
        className="h-dvh w-full snap-y snap-mandatory overflow-y-auto overscroll-y-contain"
      >
        {streams.map((stream, i) => {
          const isActive = documentVisible && i === activeIndex;
          return (
            <section
              key={stream.id}
              data-feed-index={i}
              ref={(el) => {
                slideRefs.current[i] = el;
              }}
              className="relative h-dvh w-full snap-start snap-always"
            >
              {isActive ? (
                <StreamView
                  stream={stream}
                  seller={stream.seller}
                  initialPinnedProduct={stream.pinned_product}
                  role={roleFor(stream)}
                  viewerId={viewerId}
                  viewerName={viewerName ?? undefined}
                  active
                />
              ) : (
                <Poster stream={stream} />
              )}
            </section>
          );
        })}
      </div>

      {/* Top-right grid button → /browse (old grid homepage, keeps Navbar). */}
      <button
        type="button"
        onClick={goBrowse}
        aria-label="Browse streams"
        className="absolute right-3 top-3 z-50 rounded-full bg-black/40 p-2 text-white/90 backdrop-blur-sm transition hover:bg-black/60"
      >
        <GridIcon />
      </button>
    </div>
  );
}

/** Lightweight inactive-slide placeholder — no video, no realtime, no token. */
function Poster({ stream }: { stream: StreamFeedItem }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-black px-6 text-center">
      <p className="line-clamp-2 text-lg font-medium text-white/90">
        {stream.title}
      </p>
      <p className="mt-1 text-sm text-white/50">
        by {stream.seller?.display_name ?? "Unknown"}
      </p>
    </div>
  );
}

function GridIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}
