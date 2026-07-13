## Refactor scope: "safe moves only" — APPROVED

Three behavior-preserving changes plus verification (4a already complete).

---

### Part 1 — Route groups (reorganize `src/app/`)

Create 2 layout files:
- `src/app/(shop)/layout.tsx` — server component, renders `<Navbar />` + `{children}`
- `src/app/(seller)/layout.tsx` — server component, renders `<Navbar />` + `{children}`

Move 6 pages (strip Navbar import + `<Navbar />` JSX from each):

| From | To | URL (unchanged) |
|---|---|---|
| `src/app/page.tsx` | `src/app/(shop)/page.tsx` | `/` |
| `src/app/login/page.tsx` | `src/app/(shop)/login/page.tsx` | `/login` |
| `src/app/checkout/return/page.tsx` | `src/app/(shop)/checkout/return/page.tsx` | `/checkout/return` |
| `src/app/seller/apply/page.tsx` | `src/app/(seller)/seller/apply/page.tsx` | `/seller/apply` |
| `src/app/seller/dashboard/page.tsx` | `src/app/(seller)/seller/dashboard/page.tsx` | `/seller/dashboard` |
| `src/app/seller/orders/page.tsx` | `src/app/(seller)/seller/orders/page.tsx` | `/seller/orders` |

Left in place: root `layout.tsx`, `globals.css`, `stream/[id]/page.tsx` (full-screen, no Navbar), `auth/callback/route.ts`, all `api/**`.

---

### Part 2 — Delete 3 dead legacy components

`src/components/ChatPanel.tsx` (0 importers), `src/components/PinnedProduct.tsx` (0 importers), `src/components/BuyModal.tsx` (only importer was PinnedProduct, also deleted). 8 provenance comments audited — all HISTORICAL OK, leave as-is.

---

### Part 3 — Group payments under `lib/payments/`

Move `src/lib/khalti.ts` → `src/lib/payments/khalti.ts`, `src/lib/esewa.ts` → `src/lib/payments/esewa.ts`. Update importers: `@/lib/khalti` → `@/lib/payments/khalti`, `@/lib/esewa` → `@/lib/payments/esewa`.

---

### Part 4 — Verify

**4a (DONE):** Path-literal grep clean — zero string-literal references to old file locations, zero `__dirname`/`path.join`/`fs`/dynamic-import usage.

**4b:** Run `npm run typecheck` and `npm run lint`. Fix breakages.

**4c (HARD GATE):** Manually re-run full Khalti AND eSewa checkout flow end-to-end including `/checkout/return` redirect. Do not mark done until both complete through the new route-group structure.