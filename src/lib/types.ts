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
export type OrderStatus = "pending" | "paid" | "failed";

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
  created_at: string;
}

export interface ChatMessage {
  id: string;
  stream_id: string;
  user_id: string;
  message: string;
  created_at: string;
}

/** Stream joined with its seller + currently pinned product (for list/detail). */
export interface StreamWithRelations extends Stream {
  seller?: Pick<Profile, "id" | "display_name"> | null;
  pinned_product?: Product | null;
}

export interface ChatMessageWithUser extends ChatMessage {
  profiles?: Pick<Profile, "id" | "display_name"> | null;
}
