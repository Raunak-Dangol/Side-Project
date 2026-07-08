/**
 * Minimal generated-style types for the database. In production you'd generate
 * these with `supabase gen types typescript`, but for a prototype this hand-
 * authored mapping covers every table/column the app touches.
 */
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string | null;
          role: "buyer" | "seller" | "admin";
          created_at: string;
        };
        Insert: {
          id: string;
          display_name?: string | null;
          role?: "buyer" | "seller" | "admin";
        };
        Update: {
          display_name?: string | null;
          role?: "buyer" | "seller" | "admin";
        };
      };
      products: {
        Row: {
          id: string;
          seller_id: string;
          name: string;
          price_cents: number;
          stock: number;
          image_url: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          seller_id: string;
          name: string;
          price_cents: number;
          stock: number;
          image_url?: string | null;
        };
        Update: {
          name?: string;
          price_cents?: number;
          stock?: number;
          image_url?: string | null;
        };
      };
      streams: {
        Row: {
          id: string;
          seller_id: string;
          title: string;
          status: "scheduled" | "live" | "ended";
          livekit_room_name: string;
          pinned_product_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          seller_id: string;
          title: string;
          status?: "scheduled" | "live" | "ended";
          livekit_room_name: string;
          pinned_product_id?: string | null;
        };
        Update: {
          title?: string;
          status?: "scheduled" | "live" | "ended";
          livekit_room_name?: string;
          pinned_product_id?: string | null;
        };
      };
      orders: {
        Row: {
          id: string;
          buyer_id: string;
          product_id: string;
          stream_id: string;
          payment_gateway: "khalti" | "esewa";
          gateway_transaction_id: string | null;
          status: "pending" | "paid" | "failed";
          amount_cents: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          buyer_id: string;
          product_id: string;
          stream_id: string;
          payment_gateway: "khalti" | "esewa";
          gateway_transaction_id?: string | null;
          status?: "pending" | "paid" | "failed";
          amount_cents: number;
        };
        Update: {
          gateway_transaction_id?: string | null;
          status?: "pending" | "paid" | "failed";
          amount_cents?: number;
        };
      };
      chat_messages: {
        Row: {
          id: string;
          stream_id: string;
          user_id: string;
          message: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          stream_id: string;
          user_id: string;
          message: string;
        };
        Update: {
          message?: string;
        };
      };
    };
  };
}
