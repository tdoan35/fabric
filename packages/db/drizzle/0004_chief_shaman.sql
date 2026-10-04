CREATE TABLE "schedule_fires" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"status" text DEFAULT 'fired' NOT NULL,
	"run_id" text,
	"task_id" text,
	"message_id" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"agent_id" text NOT NULL,
	"team_id" text,
	"project_id" text,
	"prompt" text NOT NULL,
	"recurrence" jsonb NOT NULL,
	"cron" text NOT NULL,
	"tz" text NOT NULL,
	"duration_min" integer DEFAULT 30 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_fires_slot_idx" ON "schedule_fires" USING btree ("schedule_id","scheduled_for");