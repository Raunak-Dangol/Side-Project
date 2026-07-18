"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AuthIntent } from "@/lib/types";
import AuthInterceptorSheet from "./AuthInterceptorSheet";

/**
 * Guest-to-auth interceptor (P2-D). Mounted once at the StreamView root, this
 * provider exposes `requireAuth(intent)` to every child that owns a gated
 * action (follow, chat send, gift, buy).
 *
 *   requireAuth(intent) -> true  : caller is signed in, proceed with the action.
 *   requireAuth(intent) -> false : caller is anon; the auth half-sheet opens and
 *                                  `intent` is stashed in sessionStorage so the
 *                                  stream view can replay it after sign-in.
 *
 * The replay itself lives in StreamView (it owns the checkout sheet, chat
 * input focus, etc.), which reads the stashed intent via `consumeStashedIntent`
 * on mount. This keeps the provider focused on "gate + remember" and lets the
 * replay logic live next to the UI it drives.
 *
 * Why sessionStorage (not localStorage): the intent is tied to this tab's
 * attempt to do something right now; it shouldn't survive a browser restart or
 * leak across tabs. It's also cleared on consume, so it's very short-lived.
 */

const INTENT_STORAGE_KEY = "live-shop:auth-intent";

/** Save an intent for the stream view to replay after auth. */
export function stashIntent(intent: AuthIntent): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // sessionStorage can throw in private mode / quota — the intent just won't
    // replay, which is acceptable (the viewer signs in normally).
  }
}

/**
 * Read + clear a stashed intent. Returns null if there isn't one or it's
 * malformed. StreamView calls this once on mount to decide whether to replay.
 */
export function consumeStashedIntent(): AuthIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(INTENT_STORAGE_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(INTENT_STORAGE_KEY);
    const parsed = JSON.parse(raw) as AuthIntent;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.kind === "string" &&
      typeof parsed.streamId === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

interface AuthInterceptorContextValue {
  /**
   * Gate a gated action. Returns true if the viewer is authenticated (caller
   * proceeds); false if anon (sheet opened, intent stashed).
   */
  requireAuth: (intent: AuthIntent) => boolean;
}

const AuthInterceptorContext = createContext<AuthInterceptorContextValue | null>(
  null,
);

interface AuthInterceptorProviderProps {
  /** The current viewer's user id, or null for anon. */
  viewerId: string | null;
  /** Where to send the viewer after a successful sign-in (the stream path). */
  redirectTo: string;
  children: ReactNode;
}

export function AuthInterceptorProvider({
  viewerId,
  redirectTo,
  children,
}: AuthInterceptorProviderProps) {
  // The sheet is controlled locally; opening it pauses the gated action.
  const [sheetOpen, setSheetOpen] = useState(false);
  // Keep the latest viewerId in a ref so `requireAuth` (stable via useCallback)
  // always sees the current auth state without re-creating on every render.
  const viewerIdRef = useRef(viewerId);
  useEffect(() => {
    viewerIdRef.current = viewerId;
  }, [viewerId]);

  const requireAuth = useCallback((intent: AuthIntent): boolean => {
    if (viewerIdRef.current) return true;
    stashIntent(intent);
    setSheetOpen(true);
    return false;
  }, []);

  return (
    <AuthInterceptorContext.Provider value={{ requireAuth }}>
      {children}
      <AuthInterceptorSheet
        open={sheetOpen}
        redirectTo={redirectTo}
        onClose={() => setSheetOpen(false)}
      />
    </AuthInterceptorContext.Provider>
  );
}

/**
 * Access the interceptor. Returns `requireAuth` that always returns true (no-op
 * gate) when used outside a provider, so consumers in non-stream contexts
 * (e.g. the /u/[id] profile page's FollowButton) don't need a conditional mount.
 */
export function useAuthInterceptor(): AuthInterceptorContextValue {
  const ctx = useContext(AuthInterceptorContext);
  // Default: always allow. Useful for surfaces that render FollowButton outside
  // the stream (the provider is only mounted inside StreamView).
  return ctx ?? { requireAuth: () => true };
}
