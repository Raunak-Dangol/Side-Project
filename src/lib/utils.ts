/** Misc small helpers shared across the app. */

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Format an integer paisa/cents amount as NPR for display. */
export function formatNpr(paisa: number): string {
  const rupees = paisa / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "NPR",
    maximumFractionDigits: 2,
  }).format(rupees);
}

/** Truncate with ellipsis. */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Up to 2 uppercase initials for avatars (email or display name → letters). */
export function initials(name: string | null | undefined): string {
  const s = (name ?? "").trim();
  if (!s) return "?";
  // For emails, use the local-part before "@".
  const local = s.includes("@") ? s.split("@")[0] : s;
  const parts = local.split(/[\s_.-]+/).filter(Boolean);
  const letters = parts.length > 1
    ? parts[0]![0]! + parts[1]![0]!
    : local.slice(0, 2);
  return letters.toUpperCase();
}

/** Relative "time ago" for chat/timestamps. */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** v4 UUID. Uses crypto.randomUUID when available (Node 19+ / evergreen browsers). */
export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback (should not be needed in this stack)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
