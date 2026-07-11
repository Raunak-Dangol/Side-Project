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
          role: "buyer" | "admin";
          is_verified: boolean;
          seller_status: "none" | "pending" | "approved" | "rejected";
          seller_applied_at: string | null;
          seller_reviewed_at: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          display_name?: string | null;
          role?: "buyer" | "admin";
          is_verified?: boolean;
          seller_status?: "none" | "pending" | "approved" | "rejected";
          seller_applied_at?: string | null;
          seller_reviewed_at?: string | null;
        };
        Update: {
          display_name?: string | null;
          role?: "buyer" | "admin";
          is_verified?: boolean;
          seller_status?: "none" | "pending" | "approved" | "rejected";
          seller_applied_at?: string | null;
          seller_reviewed_at?: string | null;
        };
        Relationships: [];
      };
      seller_applications: {
        Row: {
          id: string;
          user_id: string;
          business_name: string | null;
          contact_phone: string | null;
          id_verification_note: string | null;
          status: "pending" | "approved" | "rejected";
          submitted_at: string;
          reviewed_at: string | null;
          reviewer_note: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          business_name?: string | null;
          contact_phone?: string | null;
          id_verification_note?: string | null;
          status?: "pending" | "approved" | "rejected";
          submitted_at?: string;
          reviewed_at?: string | null;
          reviewer_note?: string | null;
        };
        Update: {
          business_name?: string | null;
          contact_phone?: string | null;
          id_verification_note?: string | null;
          status?: "pending" | "approved" | "rejected";
          reviewed_at?: string | null;
          reviewer_note?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "seller_applications_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
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
        Relationships: [];
      };
      streams: {
        Row: {
          id: string;
          seller_id: string;
          title: string;
          status: "scheduled" | "live" | "ended";
          livekit_room_name: string;
          pinned_product_id: string | null;
          promo_banner_text: string | null;
          promo_banner_link: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          seller_id: string;
          title: string;
          status?: "scheduled" | "live" | "ended";
          livekit_room_name: string;
          pinned_product_id?: string | null;
          promo_banner_text?: string | null;
          promo_banner_link?: string | null;
        };
        Update: {
          title?: string;
          status?: "scheduled" | "live" | "ended";
          livekit_room_name?: string;
          pinned_product_id?: string | null;
          promo_banner_text?: string | null;
          promo_banner_link?: string | null;
        };
        Relationships: [];
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
        Relationships: [];
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
        Relationships: [
          {
            foreignKeyName: "chat_messages_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      stream_stats: {
        Row: {
          stream_id: string;
          viewer_count: number;
          updated_at: string;
        };
        Insert: {
          stream_id: string;
          viewer_count?: number;
          updated_at?: string;
        };
        Update: {
          viewer_count?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "stream_stats_stream_id_fkey";
            columns: ["stream_id"];
            isOneToOne: true;
            referencedRelation: "streams";
            referencedColumns: ["id"];
          },
        ];
      };
      reactions: {
        Row: {
          id: string;
          stream_id: string;
          kind: "heart" | "gift";
          count: number;
          updated_at: string;
        };
        Insert: {
          id?: string;
          stream_id: string;
          kind: "heart" | "gift";
          count?: number;
          updated_at?: string;
        };
        Update: {
          count?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reactions_stream_id_fkey";
            columns: ["stream_id"];
            isOneToOne: false;
            referencedRelation: "streams";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      increment_reaction: {
        Args: { p_stream_id: string; p_kind: string; p_amount: number };
        Returns: void;
      };
      decrement_stock: {
        Args: { p_product_id: string };
        Returns: {
          id: string;
          seller_id: string;
          name: string;
          price_cents: number;
          stock: number;
          image_url: string | null;
          created_at: string;
        };
      };
      set_pinned_product: {
        Args: { p_stream: string; p_product: string };
        Returns: {
          id: string;
          seller_id: string;
          title: string;
          status: "scheduled" | "live" | "ended";
          livekit_room_name: string;
          pinned_product_id: string | null;
          created_at: string;
        };
      };
      submit_seller_application: {
        Args: {
          p_user: string;
          p_business: string;
          p_phone: string;
          p_note: string;
        };
        Returns: {
          id: string;
          user_id: string;
          business_name: string | null;
          contact_phone: string | null;
          id_verification_note: string | null;
          status: "pending" | "approved" | "rejected";
          submitted_at: string;
          reviewed_at: string | null;
          reviewer_note: string | null;
        };
      };
    };
    Enums: {
      user_role: "buyer" | "admin";
      stream_status: "scheduled" | "live" | "ended";
      payment_gateway: "khalti" | "esewa";
      order_status: "pending" | "paid" | "failed";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}
