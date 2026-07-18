"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

interface AuthInterceptorSheetProps {
  open: boolean;
  /** Path to return to after auth (the stream the viewer was watching). */
  redirectTo: string;
  onClose: () => void;
}

/**
 * In-stream sign-in half-sheet (P2-D). Presents the same two primitives as
 * `/login` (Google OAuth + magic link) but as a bottom sheet that overlays the
 * stream — so an anon viewer who taps Follow/Chat/Gift/Buy is prompted in place
 * instead of being bounced to a full-page login that unmounts the stream.
 *
 * `redirectTo` is the stream path; it's sent as the OAuth `next` so the
 * callback returns the viewer here, where StreamView's intent-replay bootstrap
 * re-fires the action they were trying to perform.
 *
 * The sheet itself does NOT perform the gated action — it only authenticates.
 * Intent replay lives in StreamView (owner of checkout/chat/follow state).
 */
export default function AuthInterceptorSheet({
  open,
  redirectTo,
  onClose,
}: AuthInterceptorSheetProps) {
  const supabase = createSupabaseBrowserClient();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"google" | "magic" | null>(null);

  if (!open) return null;

  function buildCallbackUrl(): string {
    // `/auth/callback` runs `next` through safeRelativePath before redirecting,
    // so passing the stream path is safe (open-redirect defense from P2-D.2).
    return `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`;
  }

  async function signInWithGoogle() {
    setError(null);
    setLoading("google");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: buildCallbackUrl() },
    });
    if (error) {
      setError(error.message);
      setLoading(null);
    }
    // On success the browser leaves for Google; the sheet unmounts with the page.
  }

  async function signInWithMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError("Enter your email.");
      return;
    }
    setLoading("magic");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: buildCallbackUrl() },
    });
    setLoading(null);
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  }

  return (
    // Backdrop closes the sheet on click. z-modal sits above every other overlay.
    <div
      className="absolute inset-0 z-modal flex items-end bg-black/60"
      onClick={onClose}
    >
      {/* The sheet stops propagation so taps inside don't close it. */}
      <div
        style={{ animation: "sheet-slide-up 300ms ease-out" }}
        className="w-full rounded-t-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" />
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-semibold text-lg text-ink">Sign in to continue</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              React, chat, follow & buy as a member.
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

        <div className="mt-4">
          <button
            type="button"
            onClick={signInWithGoogle}
            disabled={loading !== null}
            className="btn-secondary w-full"
          >
            {loading === "google" ? "Redirecting..." : "Continue with Google"}
          </button>

          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-xs text-slate-400">or</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          {sent ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              Check <strong>{email}</strong> for a sign-in link.
            </div>
          ) : (
            <form onSubmit={signInWithMagicLink} className="space-y-3">
              <input
                type="email"
                className="input w-full"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <button
                type="submit"
                className="btn-primary w-full"
                disabled={loading !== null}
              >
                {loading === "magic" ? "Sending..." : "Send magic link"}
              </button>
            </form>
          )}

          {error ? (
            <p className="mt-3 text-sm text-rose-600" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
