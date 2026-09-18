-- Chat with Scottie: one row per turn, tied to a completed analysis (application_request_id)
-- and its owner. Turns are kept alongside the report so a conversation survives reload; the
-- gateway stores nothing. Content is user-authored text bounded by the API (<= 2000 chars).
CREATE TABLE IF NOT EXISTS "scotty_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_request_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scotty_chat_messages_role_check" CHECK ("role" IN ('user', 'assistant'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scotty_chat_messages_request_idx" ON "scotty_chat_messages" USING btree ("application_request_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scotty_chat_messages_owner_idx" ON "scotty_chat_messages" USING btree ("owner_id","created_at");--> statement-breakpoint
-- Backend-only table: keep it away from the Supabase API roles like every other app table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    EXECUTE 'REVOKE ALL ON TABLE public.scotty_chat_messages FROM anon, authenticated';
  END IF;
  EXECUTE 'ALTER TABLE public.scotty_chat_messages ENABLE ROW LEVEL SECURITY';
END $$;
