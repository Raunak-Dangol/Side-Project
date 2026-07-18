"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface ModerationTarget {
  userId: string;
  displayName: string | null;
  /** When opened from a chat message, the message id is carried for the report. */
  messageId?: string;
}

interface ModerationContextValue {
  /** Open the menu targeting a user. */
  openModeration: (target: ModerationTarget) => void;
  /** The viewer's current block list (ids), kept in sync by StreamView. */
  blockedIds: Set<string>;
  /** Session-local mute set (not persisted). */
  mutedIds: Set<string>;
  /** Block a user; updates the local set immediately (optimistic). */
  block: (userId: string) => Promise<void>;
  /** Unblock a user. */
  unblock: (userId: string) => Promise<void>;
  /** Toggle session-local mute. */
  toggleMute: (userId: string) => void;
}

const ModerationContext = createContext<ModerationContextValue | null>(null);

interface ModerationProviderProps {
  /** The current stream id, attached to any reports filed. */
  streamId: string;
  /** Initial block list (ids) loaded by StreamView on activation. */
  initialBlockedIds: Set<string>;
  children: ReactNode;
}

/**
 * Viewer-side moderation state + sheet (P2-E). Provides `openModeration(target)`
 * to any child (chat messages, TopBar seller card, BottomActionBar overflow) so
 * the menu is reachable from everywhere a user appears.
 *
 * Two layers of "hide":
 *   * **Block** — persistent, server-backed (`/api/block`). Drives chat filtering
 *     in StreamView (blocked users' messages don't render for the blocker).
 *   * **Mute** — session-local only (a Set in memory), per the plan's
 *     "self-serve chat controls". Doesn't persist across reloads.
 *
 * **Report** — writes a row to `reports` via `/api/report` for admin review.
 *
 * The sheet itself is rendered here as a sibling of children so it overlays
 * everything at z-modal.
 */
export function ModerationProvider({
  streamId,
  initialBlockedIds,
  children,
}: ModerationProviderProps) {
  const [target, setTarget] = useState<ModerationTarget | null>(null);
  const [blockedIds, setBlockedIds] = useState<Set<string>>(initialBlockedIds);
  const [mutedIds, setMutedIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);

  const openModeration = useCallback((t: ModerationTarget) => {
    setTarget(t);
    setStatus(null);
  }, []);

  const block = useCallback(async (userId: string) => {
    // Optimistic: hide immediately so chat filters on the next render.
    setBlockedIds((prev) => new Set(prev).add(userId));
    try {
      const res = await fetch("/api/block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockedId: userId }),
      });
      if (!res.ok) {
        // Revert on failure.
        setBlockedIds((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
        setStatus("Block failed. Try again.");
      }
    } catch {
      setBlockedIds((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
      setStatus("Block failed (network).");
    }
  }, []);

  const unblock = useCallback(async (userId: string) => {
    setBlockedIds((prev) => {
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
    try {
      await fetch(
        `/api/block?blockedId=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
    } catch {
      // best-effort; the local state already reflects the unblock.
    }
  }, []);

  const toggleMute = useCallback((userId: string) => {
    setMutedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const value = useMemo<ModerationContextValue>(
    () => ({
      openModeration,
      blockedIds,
      mutedIds,
      block,
      unblock,
      toggleMute,
    }),
    [openModeration, blockedIds, mutedIds, block, unblock, toggleMute],
  );

  return (
    <ModerationContext.Provider value={value}>
      {children}
      <ModerationSheet
        target={target}
        streamId={streamId}
        blockedIds={blockedIds}
        mutedIds={mutedIds}
        status={status}
        onClose={() => setTarget(null)}
        onBlock={block}
        onUnblock={unblock}
        onToggleMute={toggleMute}
      />
    </ModerationContext.Provider>
  );
}

/** Access the moderation context. Returns null outside a provider. */
export function useModeration(): ModerationContextValue | null {
  return useContext(ModerationContext);
}

interface ModerationSheetProps {
  target: ModerationTarget | null;
  streamId: string;
  blockedIds: Set<string>;
  mutedIds: Set<string>;
  status: string | null;
  onClose: () => void;
  onBlock: (userId: string) => Promise<void>;
  onUnblock: (userId: string) => Promise<void>;
  onToggleMute: (userId: string) => void;
}

const REPORT_REASONS = [
  "Spam or scam",
  "Harassment or hate",
  "Inappropriate content",
  "Impersonation",
  "Other",
] as const;

function ModerationSheet({
  target,
  streamId,
  blockedIds,
  mutedIds,
  status,
  onClose,
  onBlock,
  onUnblock,
  onToggleMute,
}: ModerationSheetProps) {
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<string>(REPORT_REASONS[0]);
  const [reporting, setReporting] = useState(false);

  if (!target) return null;
  const isBlocked = blockedIds.has(target.userId);
  const isMuted = mutedIds.has(target.userId);

  async function submitReport() {
    if (!target) return;
    setReporting(true);
    try {
      await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportedId: target.userId,
          streamId,
          reason: reportReason,
          messageId: target.messageId ?? null,
        }),
      });
    } catch {
      // best-effort; the report may still have landed.
    }
    setReporting(false);
    onClose();
  }

  return (
    <div
      className="absolute inset-0 z-modal flex items-end bg-black/60"
      onClick={onClose}
    >
      <div
        style={{ animation: "sheet-slide-up 300ms ease-out" }}
        className="w-full rounded-t-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" />
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-semibold text-lg text-ink">
              {target.displayName ?? "Anonymous viewer"}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Manage how this user appears to you.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 transition hover:text-slate-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {reportOpen ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm font-medium text-slate-700">Reason</p>
            <div className="space-y-1.5">
              {REPORT_REASONS.map((reason) => (
                <label
                  key={reason}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50"
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={reason}
                    checked={reportReason === reason}
                    onChange={() => setReportReason(reason)}
                  />
                  {reason}
                </label>
              ))}
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setReportOpen(false)}
                className="btn-secondary flex-1"
              >
                Back
              </button>
              <button
                type="button"
                onClick={submitReport}
                disabled={reporting}
                className="btn-primary flex-1"
              >
                {reporting ? "Submitting..." : "Submit report"}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            <button
              type="button"
              onClick={() => onToggleMute(target.userId)}
              className="btn w-full justify-start"
            >
              {isMuted ? "🔇 Unmute (this session)" : "🔇 Mute (this session)"}
            </button>
            <button
              type="button"
              onClick={() =>
                isBlocked ? onUnblock(target.userId) : onBlock(target.userId)
              }
              className="btn w-full justify-start"
            >
              {isBlocked ? " Unblock user" : " Block user"}
            </button>
            <button
              type="button"
              onClick={() => setReportOpen(true)}
              className="btn w-full justify-start text-rose-600"
            >
              ⚑ Report user
            </button>
          </div>
        )}

        {status ? (
          <p className="mt-3 text-sm text-rose-600" role="alert">
            {status}
          </p>
        ) : null}
      </div>
    </div>
  );
}
