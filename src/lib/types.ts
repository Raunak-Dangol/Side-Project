// Shared domain types — kept in sync with the Supabase schema.

export type UserRole = "buyer" | "seller" | "admin";
export type StreamStatus = "scheduled" | "live" | "ended";
export type PaymentGateway = "khalti" | "esewa";
export type OrderStatus = "pending" | "paid" | "failed";

export interface Profile {
  id: string;
  display_name: string | null;
  role: UserRole;
  created_at: string;
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
