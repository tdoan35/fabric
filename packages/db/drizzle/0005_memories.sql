CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text DEFAULT 'personal' NOT NULL,
	"scope_id" text DEFAULT 'dana' NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"importance" real DEFAULT 0.5 NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"forgotten_at" timestamp with time zone,
	"embedding" vector(384),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);
--> statement-breakpoint
CREATE INDEX "memories_tsv_idx" ON "memories" USING gin ("tsv");