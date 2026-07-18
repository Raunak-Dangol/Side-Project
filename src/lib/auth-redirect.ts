/**
 * Open-redirect defense for OAuth / magic-link callbacks.
 *
 * The `next` param on `/auth/callback?next=...` tells the callback where to send
 * the user after a successful sign-in. If it's passed straight into
 * `NextResponse.redirect`, an attacker can craft a link like
 * `/auth/callback?next=//evil.com` that ships the freshly-authed user off-site
 * (protocol-relative URLs resolve against the current origin on the client but
 * are treated as absolute by some redirect implementations). This was the
 * explicit scope you opted into fixing in the Phase 2 plan.
 *
 * `safeRelativePath()` clamps any input to a same-origin relative path. The rule
 * set is strict on purpose — deny by default, allow only what is provably
 * in-app:
 *
 *   1. Must be a non-empty string.
 *   2. Must start with a single `/` (not `//`, not `/\`).
 *   3. Must not contain a backslash (browsers normalize `/foo\bar` oddly and
 *      some proxies treat backslash as a path separator).
 *   4. Must not start with `/{authority}` — i.e. `//evil.com` and `/\evil.com`
 *      are rejected up front (defense in depth even though step 2 already
 *      catches the `//` prefix).
 *
 * Anything that fails any check falls back to `fallback` (default `/`), so a
 * malformed or hostile `next` can never escape the origin.
 *
 * Pure + framework-free so it's unit-testable in isolation.
 */

/**
 * Routes the user may be returned to after auth. Entries are:
 *   - exact: matched only when `next` equals them verbatim (e.g. `/`).
 *   - prefix: matched when `next` equals the prefix OR starts with `prefix + "/"`,
 *     so `/stream/abc` matches `/stream/` but `/streamfoo` does NOT (a `startsWith`
 *     on `/stream/` would also reject `/streamfoo`, but the explicit boundary
 *     makes the intent obvious and keeps `/` from matching every path).
 */
const ALLOWED = [
  { value: "/", exact: true },
  { value: "/browse", exact: true },
  { value: "/login", exact: true },
  { value: "/orders", exact: true },
  { value: "/checkout", exact: true },
  { value: "/stream/", exact: false },
  { value: "/seller/", exact: false },
  { value: "/u/", exact: false },
] as const;

/** @returns a same-origin relative path clamped to the allowlist, or `fallback`. */
export function safeRelativePath(
  next: string | null | undefined,
  fallback = "/",
): string {
  if (typeof next !== "string" || next.length === 0) return fallback;

  // Reject anything that isn't a rooted relative path. `//x` and `/\x` are
  // protocol-relative / UNC-style and MUST be refused even if later checks
  // would pass.
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (next.includes("\\")) return fallback;

  // No control chars / whitespace that could smuggle a header or a CRLF into
  // a Location header (defense in depth; Next also validates, but cheap).
  if (/[\u0000-\u001F\u007F]/.test(next)) return fallback;

  // Allowlist: exact entries match verbatim; prefix entries match when `next`
  // equals the prefix or starts with `prefix + "/"` (so `/stream/abc` matches
  // `/stream/` but `/streamfoo` does not).
  const matched = ALLOWED.some(({ value, exact }) =>
    exact
      ? next === value
      : next === value || next.startsWith(value),
  );
  if (!matched) return fallback;

  return next;
}
