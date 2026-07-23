// Shared domain types — kept in sync with the Supabase schema.

/**
 * Platform role. NOTE: 'seller' is intentionally NOT a value here — seller
 * capability is modeled by `seller_status` on Profile, not by role. `role` is
 * retained only to distinguish platform admins.
 */
export type UserRole = "buyer" | "admin";

/** THE source of truth for "can this account act as a seller." */
export type SellerStatus = "none" | "pending" | "approved" | "rejected";

export type StreamStatus = "scheduled" | "live" | "ended";
export type PaymentGateway = "khalti" | "esewa";
export type OrderStatus = "pending" | "paid" | "failed" | "cancelled" | "expired";

export interface Profile {
  id: string;
  display_name: string | null;
  role: UserRole;
  /** Admin-granted verified-seller flag; toggled manually via SQL for now. */
  is_verified: boolean;
  /** Seller capability. See SellerStatus — the only signal for seller tools. */
  seller_status: SellerStatus;
  seller_applied_at: string | null;
  seller_reviewed_at: string | null;
  created_at: string;
}

/** One seller application submission. Reapplying after rejection adds a row. */
export interface SellerApplication {
  id: string;
  user_id: string;
  business_name: string | null;
  contact_phone: string | null;
  /** Prototype only — free-text note or a URL to an ID photo. No real KYC. */
  id_verification_note: string | null;
  status: "pending" | "approved" | "rejected";
  submitted_at: string;
  reviewed_at: string | null;
  reviewer_note: string | null;
}

export interface Product {
  id: string;
  seller_id: string;
  name: string;
  price_cents: number;
  stock: number;
  image_url: string | null;
  created_at: string;
}

export interface Stream {
  id: string;
  seller_id: string;
  title: string;
  status: StreamStatus;
  livekit_room_name: string;
  pinned_product_id: string | null;
  /** Optional full-width promo strip text; null/empty hides the banner. */
  promo_banner_text: string | null;
  /** Optional promo link opened in a new tab; null/empty makes the strip static. */
  promo_banner_link: string | null;
  created_at: string;
}

export interface Order {
  id: string;
  buyer_id: string;
  product_id: string;
  stream_id: string;
  payment_gateway: PaymentGateway;
  gateway_transaction_id: string | null;
  status: OrderStatus;
  amount_cents: number;
  /** Quantity purchased (Phase 3 §4). Defaults to 1 for historical rows. */
  quantity: number;
  /**
   * Optional shipping address (Phase 3 §4). Stored as jsonb
   * ({name, phone, line1, city}). Null for digital / pick-up-only orders.
   */
  shipping_address: ShippingAddress | null;
  /** Set when payment succeeded but stock was gone (money taken, no item). */
  needs_refund: boolean;
  /** Tracks manual refund handling: null | "refunded" | "reviewed". */
  refund_status: string | null;
  /** Khalti-issued pidx, bound to the order at initiation to block replay. */
  khalti_pidx: string | null;
  created_at: string;
}

/** Shipping address shape persisted on the order (Phase 3 §4). */
export interface ShippingAddress {
  name: string;
  phone: string;
  line1: string;
  city: string;
}

export interface ChatMessage {
  id: string;
  stream_id: string;
  user_id: string;
  message: string;
  created_at: string;
  /**
   * Phase 4: soft-delete timestamp. Null = visible; non-null = the seller
   * removed it. Filtered out of reads + realtime by `is(deleted_at, null)`.
   * Preserved (not hard-deleted) for the audit trail.
   */
  deleted_at: string | null;
}

/**
 * Seller-issued mute on a stream (Phase 4 / P4-A). The muted user's future chat
 * messages are hidden for ALL viewers of that stream — the filter lives in
 * StreamView, fed by a realtime subscription on this table. Orthogonal to the
 * viewer-side personal `blocks` list: BOTH filters apply.
 */
export interface StreamMute {
  stream_id: string;
  user_id: string;
  muted_by: string;
  created_at: string;
}

/**
 * Seller-issued ban from a stream (Phase 4 / P4-A). The banned user is refused
 * a LiveKit token (403 at /api/livekit-token) and kicked from the room. The
 * table itself is the audit trail (banned_by + reason + created_at).
 */
export interface StreamBan {
  stream_id: string;
  user_id: string;
  banned_by: string;
  reason: string;
  created_at: string;
}

/**
 * One follow edge: `follower_id` follows `followee_id`. Public (select policy
 * is `using (true)`); only the follower may create/delete their own edges.
 */
export interface Follow {
  follower_id: string;
  followee_id: string;
  created_at: string;
}

/**
 * A user's profile as rendered on /u/[id], plus the follow-graph data the page
 * needs: follower/following counts and whether the current viewer is following.
 * `is_following` is resolved server-side so the FollowButton renders correctly
 * on first paint (no flash).
 */
export interface UserProfile {
  id: string;
  display_name: string | null;
  role: UserRole;
  is_verified: boolean;
  seller_status: SellerStatus;
  follower_count: number;
  following_count: number;
  /** Whether the current viewer follows this user. False for anon / own profile. */
  is_following: boolean;
}

/** Minimal user shape for a row in the followers/following lists. */
export interface FollowListUser {
  id: string;
  display_name: string | null;
  is_verified: boolean;
}

/** Stream joined with its seller + currently pinned product (for list/detail). */
export interface StreamWithRelations extends Stream {
  seller?: Pick<Profile, "id" | "display_name"> | null;
  pinned_product?: Product | null;
}

/**
 * Minimal seller shape rendered by the vertical feed — only the fields the
 * feed UI actually reads. Kept deliberately narrow so the query stays explicit
 * (do not widen the shared `StreamWithRelations.seller` relation).
 */
export type StreamFeedSeller = Pick<
  Profile,
  "id" | "display_name" | "is_verified"
>;

/** A stream as loaded by the feed page: full Stream + feed seller + pinned product. */
export type StreamFeedItem = Stream & {
  seller: StreamFeedSeller | null;
  pinned_product: Product | null;
};

export interface ChatMessageWithUser extends ChatMessage {
  profiles?: Pick<Profile, "id" | "display_name"> | null;
}

/**
 * A stashed action a guest was trying to perform when the auth interceptor
 * prompted them to sign in (P2-D). After a successful OAuth/magic-link round
 * trip the stream view replays the intent: opens checkout, sends the follow,
 * focuses chat. Stale or invalid intents are dropped silently.
 *
 * `streamId` is carried so the replay can verify the intent still belongs to
 * the stream the viewer landed back on (avoids replaying a buy on the wrong
 * stream after navigation).
 */
export type AuthIntent =
  | { kind: "follow"; targetId: string; streamId: string }
  | { kind: "chat"; streamId: string }
  | { kind: "gift"; streamId: string }
  | { kind: "buy"; productId: string; streamId: string };
