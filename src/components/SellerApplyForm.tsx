"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  userId: string;
}

/**
 * Seller application form. Posts to /api/seller/apply (Zod-validated, atomic
 * server-side write). On success the page reloads into the "under review"
 * state. Used both for first-time applications and reapplication after
 * rejection (the server allows a new 'pending' row once the prior one is
 * rejected).
 */
export default function SellerApplyForm({ userId }: Props) {
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [idVerificationNote, setIdVerificationNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (submitting) return;
    setSubmitting(true);

    const res = await fetch("/api/seller/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        businessName: businessName.trim(),
        contactPhone: contactPhone.trim(),
        idVerificationNote: idVerificationNote.trim(),
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Please try again.");
      setSubmitting(false);
      return;
    }

    // Reload so the server re-evaluates state → shows the "under review" banner.
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="card p-6 space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Store / business name
        </label>
        <input
          className="input"
          placeholder="e.g. Raunak Handicrafts"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          maxLength={120}
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Contact phone
        </label>
        <input
          className="input"
          placeholder="e.g. +977 98XXXXXXXX"
          value={contactPhone}
          onChange={(e) => setContactPhone(e.target.value)}
          maxLength={40}
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          ID verification note
        </label>
        {/* TODO (post-prototype): real ID/business-license verification +
            deposit collection. For now this is a free-text field where the
            applicant pastes a note or a link to an ID photo hosted elsewhere. */}
        <textarea
          className="input min-h-[90px]"
          placeholder="Paste a note or a link to a photo of your ID / business license."
          value={idVerificationNote}
          onChange={(e) => setIdVerificationNote(e.target.value)}
          maxLength={1000}
          required
        />
        <p className="text-xs text-slate-400 mt-1">
          Prototype only — no real document upload or KYC happens here.
        </p>
      </div>

      {error ? (
        <p className="text-sm text-rose-600">{error}</p>
      ) : null}

      <button type="submit" className="btn-primary w-full" disabled={submitting}>
        {submitting ? "Submitting…" : "Submit application"}
      </button>
    </form>
  );
}
