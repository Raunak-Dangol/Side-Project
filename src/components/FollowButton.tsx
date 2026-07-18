"use client";

import { useState } from "react";
import { haptic } from "@/lib/haptics";
import { useAuthInterceptor } from "@/components/auth/AuthInterceptorProvider";

interface FollowButtonProps {
  targetId: string;
  initiallyFollowing: boolean;
  disabled?: boolean;
  className?: string;
  /** Current stream id, used to scope the auth-intent replay (P2-D). */
  streamId?: string;
}

/**
 * Optimistic follow/unfollow toggle. Writes go to /api/follow (POST to follow,
 * DELETE to unfollow) which RLS-scopes to the current user. On any non-2xx
 * response the optimistic toggle is reverted; a successful duplicate-follow
 * returns 200 { ok: true, alreadyFollowing: true } and is treated as success.
 *
 * Guest gate (P2-D): an anon viewer's tap opens the auth half-sheet (via the
 * interceptor) instead of firing a request that would 401. The stream id scopes
 * the stashed intent so the replay only fires on the stream the viewer was on.
 */
export default function FollowButton({
  targetId,
  initiallyFollowing,
  disabled,
  className,
  streamId,
}: FollowButtonProps) {
  const [following, setFollowing] = useState(initiallyFollowing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { requireAuth } = useAuthInterceptor();

  async function toggle() {
    if (busy || disabled) return;
    // Guest gate: bail (and open the auth sheet) if not signed in.
    if (!requireAuth({ kind: "follow", targetId, streamId: streamId ?? "" })) {
      return;
    }
    setBusy(true);
    setError(null);

    const next = !following;
    setFollowing(next); // optimistic
    haptic(); // tactile confirm on toggle (no-op on desktop/iOS)

    try {
      let res: Response;
      if (next) {
        res = await fetch("/api/follow", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ followeeId: targetId }),
        });
      } else {
        res = await fetch(
          `/api/follow?followeeId=${encodeURIComponent(targetId)}`,
          { method: "DELETE" },
        );
      }

      if (!res.ok) {
        setFollowing(!next); // revert optimistic toggle on any non-2xx
        setError("Could not update follow. Try again.");
      }
    } catch {
      setFollowing(!next); // revert on network failure
      setError("Could not update follow. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (disabled) return null;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={following}
        className={
          following
            ? "rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            : "rounded-full bg-gold px-4 py-1.5 text-sm font-semibold text-primary transition hover:bg-gold-dark disabled:opacity-60"
        }
      >
        {following ? "Following" : "Follow"}
      </button>
      {error ? (
        <p className="mt-1 text-xs text-rose-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
