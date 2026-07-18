/**
 * Lightweight haptics wrapper (plan §7). Fire-and-forget: no-ops on browsers
 * without `navigator.vibrate` (all desktops, iOS Safari) and when the user
 * has requested reduced motion — vestibular-sensitive users get neither the
 * animation nor the buzz.
 *
 * Safe to call from any client component; never throws.
 */
export function haptic(ms = 15): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
    return;
  }
  if (typeof window !== "undefined") {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (mq?.matches) return;
  }
  try {
    navigator.vibrate(ms);
  } catch {
    // Some browsers throw on cross-origin or permission denial — ignore.
  }
}
