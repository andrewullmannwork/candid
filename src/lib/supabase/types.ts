/** Generated types — replace with `supabase gen types typescript` output after migration. */
export type Database = {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          firebase_uid: string;
          email: string;
          display_name: string | null;
          is_admin: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          firebase_uid: string;
          email: string;
          display_name?: string | null;
          is_admin?: boolean;
          created_at?: string;
        };
        Update: {
          display_name?: string | null;
          email?: string;
        };
      };
      profiles: {
        Row: {
          id: string;
          user_id: string;
          insurer: string | null;
          plan_type: string | null;
          state: string | null;
          primary_concern: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          insurer?: string | null;
          plan_type?: string | null;
          state?: string | null;
          primary_concern?: string | null;
        };
        Update: {
          insurer?: string | null;
          plan_type?: string | null;
          state?: string | null;
          primary_concern?: string | null;
        };
      };
      waitlist: {
        Row: {
          id: string;
          email: string;
          source: string | null;
          referral_code: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          email: string;
          source?: string | null;
          referral_code?: string | null;
        };
        Update: never;
      };
      documents: {
        Row: {
          id: string;
          user_id: string;
          storage_path: string;
          file_name: string;
          file_size: number;
          doc_type: "eob" | "itemized_bill";
          consent_event_id: string;
          status: "uploaded" | "processing" | "processed" | "error";
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          storage_path: string;
          file_name: string;
          file_size: number;
          doc_type: "eob" | "itemized_bill";
          consent_event_id: string;
          status?: "uploaded";
        };
        Update: {
          status?: "uploaded" | "processing" | "processed" | "error";
        };
      };
      consent_events: {
        Row: {
          id: string;
          user_id: string | null;
          email: string | null;
          consent_type: ConsentType;
          consent_version: string;
          consent_text_hash: string;
          granted: boolean;
          ip_address: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          email?: string | null;
          consent_type: ConsentType;
          consent_version: string;
          consent_text_hash: string;
          granted: boolean;
          ip_address?: string | null;
          user_agent?: string | null;
        };
        Update: never;
      };
      stripe_customers: {
        Row: {
          id: string;
          user_id: string;
          stripe_customer_id: string;
          subscription_status: SubscriptionStatus;
          subscription_tier: "free" | "pro";
          current_period_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          stripe_customer_id: string;
          subscription_status?: SubscriptionStatus;
          subscription_tier?: "free" | "pro";
          current_period_end?: string | null;
        };
        Update: {
          subscription_status?: SubscriptionStatus;
          subscription_tier?: "free" | "pro";
          current_period_end?: string | null;
          updated_at?: string;
        };
      };
      support_tickets: {
        Row: {
          id: string;
          user_id: string | null;
          email: string;
          subject: string;
          body: string;
          status: "open" | "in_progress" | "resolved" | "closed";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          email: string;
          subject: string;
          body: string;
          status?: "open";
        };
        Update: {
          status?: "open" | "in_progress" | "resolved" | "closed";
          updated_at?: string;
        };
      };
    };
  };
};

export type ConsentType =
  | "tos"
  | "privacy_policy"
  | "health_data_upload"
  | "marketplace_data_sharing"
  | "aggregate_data_monetization";

export type SubscriptionStatus =
  | "none"
  | "trialing"
  | "active"
  | "canceled"
  | "past_due";
