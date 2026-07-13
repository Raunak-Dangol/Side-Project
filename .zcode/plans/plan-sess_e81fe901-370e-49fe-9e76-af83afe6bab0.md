# Plan: Address live-shop improvement areas

Scope is set by your answers: (1) scale layer = rate-limit abstraction with in-memory fallback + Redis-ready, (2) refunds = structured `needs_refund` flag + seller-side queue (no gateway calls), (3) features = **buyer order history + Navbar profile menu only** (CSV/fulfill, email receipts, KYC deferred). Plus the security/env-config and tests items, and finalizing/committing the in-flight refactor.

## 1. Security: stop the secret leak + fail-fast config
- Add `tencentkey.txt` to `.gitignore` (it's currently untracked and would be committed).
- New `src/lib/env.ts`:
  - `requireEnv(name)` → throws a clear `Missing required env var: X` instead of a cryptic crash from `process.env.X!`.
  - `serverEnv` (server-only secrets) and `publicEnv` (only `NEXT_PUBLIC_*`, safe for client) objects computed once.
  - Validate `NEXT_PUBLIC_APP_URL` is set when `NODE_ENV === 'production'` (currently silently defaults to localhost and breaks payment redirects).
- Replace `process.env.X!` reads in: `lib/supabase/server.ts`, `lib/supabase/client.ts`, `middleware.ts`, `lib/livekit.ts`, `lib/payments/esewa.ts`, `lib/payments/khalti.ts`. Client code uses `publicEnv` only (so service-role/LiveKit secrets never enter the browser bundle).
- Document new optional `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` in `.env.local.example`.

## 2. Auth helper (DRY, reduce duplication)
- New `src/lib/auth.ts`: `getAuthenticatedUser(supabase)` returning `user | null` to replace the repeated `getUser()` + null-check boilerplate in `api/chat`, `api/checkout/initiate`, `api/livekit-token`. Low-risk, same behavior.

## 3. Rate-limit scale abstraction (`lib/rate-limit.ts`)
- Keep the same `rateLimit({ key, limit })` signature/return shape (callers unchanged).
- If `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are present, lazily `import()` `@upstash/ratelimit` + `@upstash/redis` for a shared, cold-start-safe limiter; otherwise fall back to the existing in-memory sliding window.
- Add `@upstash/ratelimit` + `@upstash/redis` as deps (only loaded when configured). `getClientId` kept (note: `x-forwarded-for` is spoofable — acceptable for prototype, noted in comment).
- Note: chat already persists to the `chat_messages` Supabase table (not in-memory), so only the rate-limiter needs this; its TODO comment will be updated.

## 4. Refunds: structured flag + seller queue
- New migration `supabase/migrations/0004_orders_refund.sql`: add `needs_refund boolean not null default false` and `refund_status text` to `orders`. No RLS change (seller already reads their orders).
- Update `lib/db-types.ts` and `lib/types.ts` `Order` to include the two new fields (keeps typecheck green; runtime needs the migration applied).
- In `api/checkout/esewa/callback` and `api/checkout/khalti/callback` on oversold: set `needs_refund = true` (in addition to the existing `console.error`).
- Seller orders page: add a "Needs refund" section filtering `needs_refund = true and refund_status is null`, showing order details. Add a trusted server action `markRefunded(orderId)` (uses service client + verifies the order's product belongs to the seller) to set `refund_status='refunded'`, `needs_refund=false`.

## 5. Buyer order history + profile menu
- New `src/app/(shop)/orders/page.tsx`: auth-gated, reads the buyer's own orders (RLS allows `buyer_id = auth.uid()`), renders a table (product, amount, gateway, status, date) reusing the existing `StatusBadge` styling.
- `components/Navbar.tsx`: replace the plain user chip with a dropdown menu — "My orders" (`/orders`), "Become a seller" (if not approved), profile display, and sign out.

## 6. Tests (Vitest)
- Add `vitest` dev dep + `vitest.config.ts`; add `"test": "vitest run"` script.
- Unit tests (pure, no external services): `verifyEsewaSignature` roundtrip + tamper rejection; `buildEsewaFormPayload` produces the correct signed fields; Khalti `authHeader()` shape; `rateLimit` window allow/block; `requireEnv` throws when missing.

## 7. Verify & finalize
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` — all must pass.
- **Action required from you:** apply migration `0004` (`supabase db push` or run the SQL) before the refund queue + (any new column reads) work at runtime. Typecheck/build pass regardless.
- **HARD GATE caveat:** the manual end-to-end Khalti + eSewa checkout with live credentials still needs you to run it; the new tests cover the signature/lookup/verification logic but not the live gateway round-trip.
- Commit the in-flight refactor + these improvements (currently staged/uncommitted) as one cohesive commit for your review.

### Files touched (summary)
- New: `src/lib/env.ts`, `src/lib/auth.ts`, `src/app/(shop)/orders/page.tsx`, `supabase/migrations/0004_orders_refund.sql`, `vitest.config.ts`, test files.
- Modified: `.gitignore`, `lib/supabase/{server,client}.ts`, `middleware.ts`, `lib/livekit.ts`, `lib/payments/{esewa,khalti}.ts`, `lib/rate-limit.ts`, `lib/db-types.ts`, `lib/types.ts`, both payment callbacks, seller `orders/page.tsx`, `components/Navbar.tsx`, `package.json`, `.env.local.example`.